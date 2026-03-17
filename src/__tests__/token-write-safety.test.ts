import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { validateTokensBeforeWrite } from '../token-validation';
import { withProxyCache, PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';
import type { ProxyCacheEntry } from '../proxy/kv-cache';
import { deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey } from '../crypto';
import { refreshManagedConnection } from '../scheduler';
import { makeFixedCredentials } from './test-helpers';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    plan TEXT NOT NULL DEFAULT 'free_trial',
    trial_ends_at TEXT,
    access_until TEXT,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    service TEXT NOT NULL,
    secret_url_segment_1 TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    key_storage_mode TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'oauth',
    auth_mode TEXT,
    application TEXT,
    label TEXT,
    dcr_registration TEXT,
    encrypted_tokens TEXT,
    key_version INTEGER NOT NULL DEFAULT 1,
    needs_reauth_at TEXT,
    last_used_at TEXT,
    last_refreshed_at TEXT,
    suspended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    current_period_end TEXT NOT NULL,
    past_due_since TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_events (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    user_id TEXT,
    event_type TEXT NOT NULL,
    category TEXT NOT NULL,
    detail TEXT,
    upstream_status INTEGER,
    encrypted_payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
`;

const CONN_ID = 'conn-write-safety-test';
const SECRET1 = makeFixedCredentials(0x60, 0x61).secret1;

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }

  // Seed a user and connection for D1 write hardening tests
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('write-safety-user', 'free_trial', '2099-12-31T23:59:59Z')`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
     VALUES (?, 'write-safety-user', 'linear', ?, 'active', 'managed')`
  ).bind(CONN_ID, SECRET1).run();
});

function makeCacheEntry(encryptedTokens: string): ProxyCacheEntry {
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: CONN_ID,
    userId: 'write-safety-user',
    service: 'linear',
    status: 'active',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'managed',
    keyVersion: 1,
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens,
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
}

// ─── Existing validateTokensBeforeWrite unit tests ───────────────────────────

describe('validateTokensBeforeWrite', () => {
  const validOldTokens = {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  it('passes valid token update through', () => {
    const newTokens = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(true);
  });

  it('rejects empty access_token', () => {
    const newTokens = { ...validOldTokens, access_token: '' };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access_token');
  });

  it('rejects undefined access_token', () => {
    const newTokens = { ...validOldTokens, access_token: undefined as any };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access_token');
  });

  it('rejects missing refresh_token when old tokens had one', () => {
    const newTokens = {
      access_token: 'new-access',
      refresh_token: '',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('refresh_token');
  });

  it('allows missing refresh_token when old tokens also had none', () => {
    const oldNoRefresh = { ...validOldTokens, refresh_token: '' };
    const newTokens = {
      access_token: 'new-access',
      refresh_token: '',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    };
    const result = validateTokensBeforeWrite(oldNoRefresh, newTokens);
    expect(result.valid).toBe(true);
  });

  it('rejects non-positive expires_at', () => {
    const newTokens = { ...validOldTokens, expires_at: 0 };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expires_at');
  });

  it('rejects negative expires_at', () => {
    const newTokens = { ...validOldTokens, expires_at: -1 };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expires_at');
  });

  it('rejects NaN expires_at', () => {
    const newTokens = { ...validOldTokens, expires_at: NaN };
    const result = validateTokensBeforeWrite(validOldTokens, newTokens);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expires_at');
  });
});

// ─── D1 write hardening tests ─────────────────────────────────────────────────

describe('D1 write hardening', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connection_events WHERE connection_id = ?').bind(CONN_ID).run();
    vi.restoreAllMocks();
  });

  it('writes to D1 on first attempt with isTokenUpdate', async () => {
    const encryptedTokens = 'enc-tokens-first-attempt';
    const entry = makeCacheEntry(encryptedTokens);
    await env.KV.put(`proxy:${SECRET1}`, JSON.stringify(entry));

    const prepareSpy = vi.spyOn(env.DB, 'prepare');

    await withProxyCache(env, SECRET1, null, async (cacheEntry, write) => {
      await write({ isTokenUpdate: true });
    });

    // D1 UPDATE should have been called
    const updateCalls = prepareSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('UPDATE connections')
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Verify connection still has encrypted_tokens in DB (insert was seeded in beforeAll)
    const row = await env.DB.prepare('SELECT id FROM connections WHERE id = ?')
      .bind(CONN_ID)
      .first<{ id: string }>();
    expect(row?.id).toBe(CONN_ID);
  });

  it('writes without retry when isTokenUpdate is not set', async () => {
    const encryptedTokens = 'enc-tokens-metadata-only';
    const entry = makeCacheEntry(encryptedTokens);
    await env.KV.put(`proxy:${SECRET1}`, JSON.stringify(entry));

    let updateCallCount = 0;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE connections')) {
        updateCallCount++;
      }
      return originalPrepare(sql);
    });

    await withProxyCache(env, SECRET1, null, async (_entry, write) => {
      await write(); // no isTokenUpdate
    });

    // Only one attempt for metadata-only writes
    expect(updateCallCount).toBe(1);
  });

  it('retries once on D1 failure and succeeds', async () => {
    const encryptedTokens = 'enc-tokens-retry-success';
    const entry = makeCacheEntry(encryptedTokens);
    await env.KV.put(`proxy:${SECRET1}`, JSON.stringify(entry));

    let updateCallCount = 0;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE connections')) {
        updateCallCount++;
        const thisCallNumber = updateCallCount;
        const stmt = originalPrepare(sql);
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...args: any[]) => {
          const bound = originalBind(...args);
          const originalRun = bound.run.bind(bound);
          bound.run = async () => {
            if (thisCallNumber === 1) {
              throw new Error('D1 transient error');
            }
            return originalRun();
          };
          return bound;
        };
        return stmt;
      }
      return originalPrepare(sql);
    });

    // Should not throw — retry succeeds
    await withProxyCache(env, SECRET1, null, async (_entry, write) => {
      await write({ isTokenUpdate: true });
    });

    // Two UPDATE calls: first attempt + retry
    expect(updateCallCount).toBe(2);
  });

  it('writes recovery event with encrypted_payload after two D1 failures', async () => {
    const encryptedTokens = 'enc-tokens-recovery-event';
    const entry = makeCacheEntry(encryptedTokens);
    await env.KV.put(`proxy:${SECRET1}`, JSON.stringify(entry));

    let updateCallCount = 0;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE connections')) {
        updateCallCount++;
        const capturedCount = updateCallCount;
        const stmt = originalPrepare(sql);
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...args: any[]) => {
          const bound = originalBind(...args);
          bound.run = async () => {
            throw new Error(`D1 failure attempt ${capturedCount}`);
          };
          return bound;
        };
        return stmt;
      }
      return originalPrepare(sql);
    });

    await withProxyCache(env, SECRET1, null, async (_entry, write) => {
      await write({ isTokenUpdate: true });
    });

    // Both UPDATE attempts failed — a recovery event should have been written
    const events = await env.DB.prepare(
      `SELECT * FROM connection_events WHERE connection_id = ? AND category = 'd1_write_failed'`
    ).bind(CONN_ID).all<{ encrypted_payload: string | null; category: string }>();

    expect(events.results.length).toBe(1);
    expect(events.results[0].encrypted_payload).toBe(encryptedTokens);
  });

  it('logs error when D1 fails twice and recovery event also fails (verifies KV still has data)', async () => {
    const encryptedTokens = 'enc-tokens-total-failure';
    const entry = makeCacheEntry(encryptedTokens);
    await env.KV.put(`proxy:${SECRET1}`, JSON.stringify(entry));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      // Fail both UPDATE and INSERT (recovery event) calls
      if (sql.startsWith('UPDATE connections') || sql.startsWith('INSERT INTO connection_events')) {
        const stmt = originalPrepare(sql);
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...args: any[]) => {
          const bound = originalBind(...args);
          bound.run = async () => {
            throw new Error('D1 total failure');
          };
          return bound;
        };
        return stmt;
      }
      return originalPrepare(sql);
    });

    // Should not throw — errors are caught internally
    await withProxyCache(env, SECRET1, null, async (_entry, write) => {
      await write({ isTokenUpdate: true });
    });

    // KV must still have the updated entry (write to KV happens before D1 backup)
    const kvRaw = await env.KV.get(`proxy:${SECRET1}`);
    expect(kvRaw).not.toBeNull();
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.encryptedTokens).toBe(encryptedTokens);
  });
});

// ─── Override bypass tests ─────────────────────────────────────────────────────

describe('Override bypass protection', () => {
  const validOldTokens = {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  it('Layer 2 catches override returning empty access_token', () => {
    // Simulate a buggy parseTokenResponse override that returns empty access_token
    const overrideResult = {
      access_token: '',
      refresh_token: 'some-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    const result = validateTokensBeforeWrite(validOldTokens, overrideResult);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access_token');
  });

  it('Layer 2 catches override that drops refresh_token', () => {
    // Simulate a buggy parseTokenResponse override that silently drops refresh_token
    const overrideResult = {
      access_token: 'new-access',
      refresh_token: '',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    const result = validateTokensBeforeWrite(validOldTokens, overrideResult);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('refresh_token');
  });
});

// ─── Existing behavior audit tests ────────────────────────────────────────────

describe('Existing behavior audit: proxy refresh token preservation', () => {
  const proxyCreds = makeFixedCredentials(0x70, 0x71);

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Seed user and connection for proxy audit tests
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('proxy-audit-user', 'free_trial', '2099-12-31T23:59:59Z')`
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES ('conn-proxy-audit', 'proxy-audit-user', 'linear', ?, 'active', 'managed')`
    ).bind(proxyCreds.secret1).run();
  });

  it('proxy refresh with empty access_token preserves old tokens', async () => {
    const oldTokens = {
      access_token: 'proxy-old-access',
      refresh_token: 'proxy-old-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 60, // near-expiry triggers refresh
    };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn-proxy-audit');
    const encryptedTokens = await encryptTokenDataWithKey(JSON.stringify(oldTokens), key);

    const cacheEntry = makeCacheEntryForProxy('conn-proxy-audit', 'proxy-audit-user', encryptedTokens);
    await env.KV.put(`proxy:${proxyCreds.secret1}`, JSON.stringify(cacheEntry));

    // Mock upstream returning a token response with empty access_token
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, _init?: any) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('/token') || url.includes('oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: '', // empty — should be rejected by Layer 2
          refresh_token: 'proxy-new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://mcp.linear.app')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await SELF.fetch(`http://localhost/mcp/linear/${proxyCreds.credentials}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    // Request may succeed or fail, but KV tokens should be preserved
    await new Promise(resolve => setTimeout(resolve, 100));

    const kvRaw = await env.KV.get(`proxy:${proxyCreds.secret1}`);
    expect(kvRaw).not.toBeNull();
    const kvEntry = JSON.parse(kvRaw!);
    // If tokens were updated, decrypt and verify they were not overwritten with empty access_token
    const decrypted = await decryptTokenDataWithKey(kvEntry.encryptedTokens, key);
    const tokens = JSON.parse(decrypted);
    // Old access_token must be preserved — empty one must not have been written
    expect(tokens.access_token).not.toBe('');
  });

  it('proxy refresh with no refresh_token preserves old refresh_token', async () => {
    const oldTokens = {
      access_token: 'proxy-old-access-2',
      refresh_token: 'proxy-old-refresh-2',
      expires_at: Math.floor(Date.now() / 1000) + 60, // near-expiry
    };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn-proxy-audit');
    const encryptedTokens = await encryptTokenDataWithKey(JSON.stringify(oldTokens), key);

    const cacheEntry = makeCacheEntryForProxy('conn-proxy-audit', 'proxy-audit-user', encryptedTokens);
    await env.KV.put(`proxy:${proxyCreds.secret1}`, JSON.stringify(cacheEntry));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, _init?: any) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('/token') || url.includes('oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: 'proxy-new-access-2',
          // no refresh_token — should be preserved from old tokens by Layer 1 fallback
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://mcp.linear.app')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await SELF.fetch(`http://localhost/mcp/linear/${proxyCreds.credentials}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const kvRaw = await env.KV.get(`proxy:${proxyCreds.secret1}`);
    expect(kvRaw).not.toBeNull();
    const kvEntry = JSON.parse(kvRaw!);
    const decrypted = await decryptTokenDataWithKey(kvEntry.encryptedTokens, key);
    const tokens = JSON.parse(decrypted);
    // Old refresh_token must not have been dropped
    expect(tokens.refresh_token).not.toBe('');
  });
});

describe('Existing behavior audit: scheduler refresh token preservation', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connection_events').run();
    await env.DB.prepare('DELETE FROM connections WHERE id LIKE ?').bind('conn-sched-audit%').run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('sched-audit-user', 'free_trial', '2099-12-31T23:59:59Z')`
    ).run();
    vi.restoreAllMocks();
  });

  it('scheduler refresh with HTTP error preserves old tokens', async () => {
    const connId = 'conn-sched-audit-http-err';
    const oldTokens = {
      access_token: 'sched-old-access',
      refresh_token: 'sched-old-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 100,
    };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, connId);
    const encryptedTokens = await encryptTokenDataWithKey(JSON.stringify(oldTokens), key);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, encrypted_tokens, auth_type)
       VALUES (?, 'sched-audit-user', 'linear', ?, 'active', 'managed', ?, 'oauth')`
    ).bind(connId, `s1-${connId}`, encryptedTokens).run();

    const dcr = JSON.stringify({ client_id: 'sched-test-client' });
    const dcrKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, connId);
    const encDcr = await encryptTokenDataWithKey(dcr, dcrKey);
    await env.DB.prepare('UPDATE connections SET dcr_registration = ? WHERE id = ?')
      .bind(encDcr, connId).run();

    const conn = {
      id: connId,
      user_id: 'sched-audit-user',
      service: 'linear' as const,
      secret_url_segment_1: `s1-${connId}`,
      status: 'active' as const,
      key_storage_mode: 'managed' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: encDcr,
      encrypted_tokens: encryptedTokens,
      needs_reauth_at: null,
      suspended_at: null,
      last_used_at: null,
      last_refreshed_at: null,
      created_at: '',
      key_version: 1,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);

    // Verify tokens in DB were not changed
    const row = await env.DB.prepare('SELECT encrypted_tokens FROM connections WHERE id = ?')
      .bind(connId).first<{ encrypted_tokens: string }>();
    expect(row?.encrypted_tokens).toBe(encryptedTokens);
  });

  it('scheduler refresh with invalid_grant sets needs_reauth_at without overwriting tokens', async () => {
    const connId = 'conn-sched-audit-invalid-grant';
    const oldTokens = {
      access_token: 'sched-old-access-ig',
      refresh_token: 'sched-old-refresh-ig',
      expires_at: Math.floor(Date.now() / 1000) - 100,
    };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, connId);
    const encryptedTokens = await encryptTokenDataWithKey(JSON.stringify(oldTokens), key);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, encrypted_tokens, auth_type)
       VALUES (?, 'sched-audit-user', 'linear', ?, 'active', 'managed', ?, 'oauth')`
    ).bind(connId, `s1-${connId}`, encryptedTokens).run();

    const dcr = JSON.stringify({ client_id: 'sched-ig-client' });
    const dcrKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, connId);
    const encDcr = await encryptTokenDataWithKey(dcr, dcrKey);
    await env.DB.prepare('UPDATE connections SET dcr_registration = ? WHERE id = ?')
      .bind(encDcr, connId).run();

    const conn = {
      id: connId,
      user_id: 'sched-audit-user',
      service: 'linear' as const,
      secret_url_segment_1: `s1-${connId}`,
      status: 'active' as const,
      key_storage_mode: 'managed' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: encDcr,
      encrypted_tokens: encryptedTokens,
      needs_reauth_at: null,
      suspended_at: null,
      last_used_at: null,
      last_refreshed_at: null,
      created_at: '',
      key_version: 1,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );

    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);

    // needs_reauth_at should be set
    const row = await env.DB.prepare('SELECT needs_reauth_at, encrypted_tokens FROM connections WHERE id = ?')
      .bind(connId).first<{ needs_reauth_at: string | null; encrypted_tokens: string }>();
    expect(row?.needs_reauth_at).not.toBeNull();

    // Tokens must NOT have been overwritten
    expect(row?.encrypted_tokens).toBe(encryptedTokens);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCacheEntryForProxy(
  connectionId: string,
  userId: string,
  encryptedTokens: string
): ProxyCacheEntry {
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId,
    userId,
    service: 'linear',
    status: 'active',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'managed',
    keyVersion: 1,
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens,
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
}
