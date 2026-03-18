import { describe, it, expect, beforeAll } from 'vitest';
import { buildProxyCacheEntry, withProxyCache, deleteProxyCache, checkCachedAccessActive, decryptCacheTokens, PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';
import { getManagedEncryptionKeys } from '../index';
import type { Connection, User } from '@bindify/types';
import { SELF, env } from 'cloudflare:test';
import { encryptTokenData, deriveManagedEncryptionKey, encryptTokenDataWithKey } from '../crypto';
import { makeFixedCredentials } from './test-helpers';
import { processWebhookEvent } from '../billing/webhook';

// Helper schema for tests that need D1
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
    metadata TEXT,
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
CREATE TABLE IF NOT EXISTS refresh_locks (
    connection_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
`;

describe('buildProxyCacheEntry', () => {
  const connection: Connection = {
    id: 'conn-1',
    user_id: 'user-1',
    service: 'todoist' as any,
    secret_url_segment_1: 'secret1abc',
    status: 'active',
    key_storage_mode: 'managed',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    label: null,
    dcr_registration: null,
    encrypted_tokens: null,
    key_version: 1,
    needs_reauth_at: null,
    suspended_at: null,
    last_used_at: null,
    last_refreshed_at: null,
    metadata: null,
    created_at: '2026-03-01T00:00:00Z',
  };

  const user: User = {
    id: 'user-1',
    stripe_customer_id: 'cus_123',
    plan: 'active',
    trial_ends_at: null,
    access_until: null,
    email: null,
    created_at: '2026-03-01T00:00:00Z',
  };

  it('assembles entry from connection, user, and subscription data', () => {
    const entry = buildProxyCacheEntry(connection, user, 'active', null, 'encrypted-blob');
    expect(entry.schemaVersion).toBe(PROXY_CACHE_SCHEMA_VERSION);
    expect(entry.connectionId).toBe('conn-1');
    expect(entry.userId).toBe('user-1');
    expect(entry.service).toBe('todoist');
    expect(entry.status).toBe('active');
    expect(entry.authType).toBe('oauth');
    expect(entry.keyStorageMode).toBe('managed');
    expect(entry.encryptedTokens).toBe('encrypted-blob');
    expect(entry.user.plan).toBe('active');
    expect(entry.subscriptionStatus).toBe('active');
    expect(entry.subscriptionPastDueSince).toBeNull();
    expect(entry.cachedAt).toBeDefined();
  });

  it('handles free trial user', () => {
    const trialUser = { ...user, plan: 'free_trial' as const, trial_ends_at: '2026-04-01T00:00:00Z' };
    const entry = buildProxyCacheEntry(connection, trialUser, null, null, 'encrypted-blob');
    expect(entry.user.plan).toBe('free_trial');
    expect(entry.user.trialEndsAt).toBe('2026-04-01T00:00:00Z');
    expect(entry.subscriptionStatus).toBeNull();
  });

  it('includes DCR registration and application', () => {
    const conn = { ...connection, dcr_registration: 'encrypted-dcr', application: 'jira' };
    const entry = buildProxyCacheEntry(conn, user, 'active', null, 'encrypted-blob');
    expect(entry.dcrRegistration).toBe('encrypted-dcr');
    expect(entry.application).toBe('jira');
  });

  it('includes subscriptionPastDueSince when provided', () => {
    const entry = buildProxyCacheEntry(connection, user, 'past_due', '2026-03-10T00:00:00Z', 'encrypted-blob');
    expect(entry.subscriptionStatus).toBe('past_due');
    expect(entry.subscriptionPastDueSince).toBe('2026-03-10T00:00:00Z');
  });
});

describe('withProxyCache', () => {
  beforeAll(async () => {
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  });

  it('returns null for cache miss', async () => {
    const result = await withProxyCache(env as any, 'nonexistent', null, async (entry, write) => {
      return entry;
    });
    expect(result).toBeNull();
  });

  it('reads an existing cache entry', async () => {
    const entry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: 'conn-read',
      userId: 'user-1',
      service: 'todoist',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyVersion: 1,
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: 'some-encrypted-blob',
      user: { plan: 'active', trialEndsAt: null, accessUntil: null },
      subscriptionStatus: 'active',
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put('proxy:secret1-read', JSON.stringify(entry));

    const result = await withProxyCache(env as any, 'secret1-read', null, async (e, write) => {
      return e;
    });
    expect(result?.connectionId).toBe('conn-read');
    expect(result?.service).toBe('todoist');
  });

  it('mutates and writes back when write() is called', async () => {
    const entry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: 'conn-mutate',
      userId: 'user-1',
      service: 'todoist',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyVersion: 1,
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: 'old-blob',
      user: { plan: 'active', trialEndsAt: null, accessUntil: null },
      subscriptionStatus: 'active',
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put('proxy:secret1-mutate', JSON.stringify(entry));

    await withProxyCache(env as any, 'secret1-mutate', null, async (e, write) => {
      e.encryptedTokens = 'new-blob';
      await write();
    });

    const raw = await env.KV.get('proxy:secret1-mutate');
    const updated = JSON.parse(raw!);
    expect(updated.encryptedTokens).toBe('new-blob');
  });

  it('does not write when write() is not called', async () => {
    const entry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: 'conn-nowrite',
      userId: 'user-1',
      service: 'todoist',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyVersion: 1,
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: 'original-blob',
      user: { plan: 'active', trialEndsAt: null, accessUntil: null },
      subscriptionStatus: 'active',
      subscriptionPastDueSince: null,
      cachedAt: '2026-01-01T00:00:00Z',
    };
    await env.KV.put('proxy:secret1-nowrite', JSON.stringify(entry));

    await withProxyCache(env as any, 'secret1-nowrite', null, async (e, write) => {
      return e.encryptedTokens;
    });

    const raw = await env.KV.get('proxy:secret1-nowrite');
    const unchanged = JSON.parse(raw!);
    expect(unchanged.cachedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('treats unrecognized schema version as cache miss', async () => {
    const entry = {
      schemaVersion: 999,
      connectionId: 'conn-old',
      encryptedTokens: 'blob',
    };
    await env.KV.put('proxy:secret1-old', JSON.stringify(entry));

    const result = await withProxyCache(env as any, 'secret1-old', null, async (e, write) => {
      return e;
    });
    expect(result).toBeNull();

    const raw = await env.KV.get('proxy:secret1-old');
    expect(raw).toBeNull();
  });
});

describe('deleteProxyCache', () => {
  it('writes tombstone instead of deleting', async () => {
    await env.KV.put('proxy:secret1-del', JSON.stringify({ test: true }));
    await deleteProxyCache(env as any, 'secret1-del');
    const raw = await env.KV.get('proxy:secret1-del');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.schemaVersion).toBe(0);
    expect(parsed.deleted).toBe(true);
  });

  it('tombstone causes withProxyCache to return null', async () => {
    await deleteProxyCache(env as any, 'secret1-tomb');
    const result = await withProxyCache(env as any, 'secret1-tomb', null, async () => 'should-not-reach');
    expect(result).toBeNull();
  });
});

describe('checkCachedAccessActive', () => {
  it('allows active subscription', () => {
    const result = checkCachedAccessActive({
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    }, 'active', null);
    expect(result.active).toBe(true);
  });

  it('allows active free trial', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'free_trial',
      trialEndsAt: futureDate,
      accessUntil: null,
    }, null, null);
    expect(result.active).toBe(true);
  });

  it('blocks expired free trial', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'free_trial',
      trialEndsAt: pastDate,
      accessUntil: null,
    }, null, null);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('trial');
  });

  it('allows canceled with future access_until', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'canceled',
      trialEndsAt: null,
      accessUntil: futureDate,
    }, 'canceled', null);
    expect(result.active).toBe(true);
  });

  it('blocks canceled with past access_until', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'canceled',
      trialEndsAt: null,
      accessUntil: pastDate,
    }, 'canceled', null);
    expect(result.active).toBe(false);
  });

  it('allows trialing subscription', () => {
    const result = checkCachedAccessActive({
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    }, 'trialing', null);
    expect(result.active).toBe(true);
  });

  it('blocks when no active subscription and not trial/canceled', () => {
    const result = checkCachedAccessActive({
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    }, null, null);
    expect(result.active).toBe(false);
  });

  it('allows past_due within 3-day grace period', () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    }, 'past_due', recentDate);
    expect(result.active).toBe(true);
  });

  it('blocks past_due beyond 3-day grace period', () => {
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = checkCachedAccessActive({
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    }, 'past_due', oldDate);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('past due');
  });
});

describe('decryptCacheTokens', () => {
  it('decrypts zero-knowledge OAuth tokens with secret2', async () => {
    const tokens = { access_token: 'at-123', refresh_token: 'rt-456', expires_at: 9999999999 };
    const encrypted = await encryptTokenData(JSON.stringify(tokens), 'my-secret2');

    const entry = {
      authType: 'oauth' as const,
      keyStorageMode: 'zero_knowledge' as const,
      keyVersion: 1,
      connectionId: 'conn-zk',
      encryptedTokens: encrypted,
    } as any;

    const result = await decryptCacheTokens(entry, 'my-secret2', getManagedEncryptionKeys(env as any));
    expect(result).toEqual(tokens);
  });

  it('decrypts managed OAuth tokens with managed key', async () => {
    const tokens = { access_token: 'at-managed', refresh_token: 'rt-managed', expires_at: 9999999999 };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn-managed');
    const encrypted = await encryptTokenDataWithKey(JSON.stringify(tokens), key);

    const entry = {
      authType: 'oauth' as const,
      keyStorageMode: 'managed' as const,
      keyVersion: 1,
      connectionId: 'conn-managed',
      encryptedTokens: encrypted,
    } as any;

    const result = await decryptCacheTokens(entry, 'unused-secret2', getManagedEncryptionKeys(env as any));
    expect(result).toEqual(tokens);
  });

  it('decrypts API key data', async () => {
    const apiKeyData = { api_key: 'my-api-key-123' };
    const encrypted = await encryptTokenData(JSON.stringify(apiKeyData), 'my-secret2');

    const entry = {
      authType: 'api_key' as const,
      keyStorageMode: 'zero_knowledge' as const,
      keyVersion: 1,
      connectionId: 'conn-api',
      encryptedTokens: encrypted,
    } as any;

    const result = await decryptCacheTokens(entry, 'my-secret2', getManagedEncryptionKeys(env as any));
    expect(result).toEqual(apiKeyData);
  });
});

describe('proxy cache integration', () => {
  const INT_USER_ID = 'int-user-1';
  const INT_CONN_ID = 'int-conn-1';
  const intCreds = makeFixedCredentials(0x50, 0x51);
  const INT_SECRET1 = intCreds.secret1;

  beforeAll(async () => {
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  });

  it('proxy request uses KV cache instead of D1', async () => {
    // Set up user + connection in D1
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES (?, 'free_trial', '2099-12-31T23:59:59Z')`
    ).bind(INT_USER_ID).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, 'linear', ?, 'active', 'managed')`
    ).bind(INT_CONN_ID, INT_USER_ID, INT_SECRET1).run();

    // Encrypt tokens and write cache entry to KV
    const tokens = {
      access_token: 'test-at-integration',
      refresh_token: 'test-rt-integration',
      expires_at: Math.floor(Date.now() / 1000) + 86400,
    };
    const key = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, INT_CONN_ID);
    const encrypted = await encryptTokenDataWithKey(JSON.stringify(tokens), key);

    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: INT_CONN_ID,
      userId: INT_USER_ID,
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyVersion: 1,
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: encrypted,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${INT_SECRET1}`, JSON.stringify(cacheEntry));

    // Mock globalThis.fetch so the upstream call returns a response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://mcp.linear.app')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    try {
      // Send a proxy request via SELF — streamable HTTP (POST to /mcp/{service}/{s1}/{s2})
      const response = await SELF.fetch(`http://localhost/mcp/linear/${intCreds.credentials}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      // The request should succeed (200) — proving the cache was read, not D1
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.jsonrpc).toBe('2.0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 404 on cache miss (fail closed)', async () => {
    // Connection exists in D1 but NOT in KV cache
    const missUserId = 'int-user-miss';
    const missConnId = 'int-conn-miss';
    const missCreds = makeFixedCredentials(0x60, 0x61);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES (?, 'free_trial', '2099-12-31T23:59:59Z')`
    ).bind(missUserId).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, 'linear', ?, 'active', 'managed')`
    ).bind(missConnId, missUserId, missCreds.secret1).run();

    // No KV cache entry for this secret1
    const response = await SELF.fetch(`http://localhost/mcp/linear/${missCreds.credentials}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    // Proxy should return 404 because it only reads from KV, not D1
    expect(response.status).toBe(404);
  });

  it('webhook billing change updates cache immediately', async () => {
    // Set up user with stripe_customer_id + subscription + connection + cache entry
    const whUserId = 'wh-cache-user';
    const whConnId = 'wh-cache-conn';
    const whSecret1 = 'wh-cache-secret1';
    const whCustomerId = 'cus_wh_cache_test';

    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, stripe_customer_id, plan) VALUES (?, ?, 'active')`
    ).bind(whUserId, whCustomerId).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, 'linear', ?, 'active', 'managed')`
    ).bind(whConnId, whUserId, whSecret1).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO subscriptions (id, user_id, quantity, status, current_period_end)
       VALUES (?, ?, 1, 'active', '2099-12-31T23:59:59Z')`
    ).bind('sub_wh_test', whUserId).run();

    // Write initial cache entry with active subscription
    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: whConnId,
      userId: whUserId,
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyVersion: 1,
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: 'placeholder-encrypted',
      user: { plan: 'active', trialEndsAt: null, accessUntil: null },
      subscriptionStatus: 'active',
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${whSecret1}`, JSON.stringify(cacheEntry));

    // Process a subscription.deleted webhook event
    const currentPeriodEnd = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    await processWebhookEvent(env as any, {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_wh_test',
          customer: whCustomerId,
          current_period_end: currentPeriodEnd,
        },
      },
    });

    // Verify cache entry was updated
    const raw = await env.KV.get(`proxy:${whSecret1}`);
    expect(raw).not.toBeNull();
    const updated = JSON.parse(raw!);
    expect(updated.user.plan).toBe('canceled');
    expect(updated.subscriptionStatus).toBeNull(); // no active sub after deletion
    expect(updated.user.accessUntil).toBe(new Date(currentPeriodEnd * 1000).toISOString());
  });
});
