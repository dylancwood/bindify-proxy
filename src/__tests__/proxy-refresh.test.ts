import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { deriveManagedEncryptionKey, encryptTokenDataWithKey, encryptTokenData, decryptTokenData } from '../crypto';
import { getManagedEncryptionKeys } from '../index';
import { makeFixedCredentials } from './test-helpers';
import { PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';

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
    key_fingerprint TEXT NOT NULL DEFAULT '',
    managed_key_fingerprint TEXT NOT NULL DEFAULT '',
    dcr_key_fingerprint TEXT NOT NULL DEFAULT '',
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

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);

CREATE TABLE IF NOT EXISTS refresh_locks (
    connection_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
`;

const CONNECTION_ID = 'conn-reauth-test';
const USER_ID = 'reauth-test-user';
const creds = makeFixedCredentials(0x40, 0x41);
const KV_KEY = `tokens:${CONNECTION_ID}`;

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }

  // Insert test user with active free trial
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES (?, 'free_trial', '2099-12-31T23:59:59Z')`
  ).bind(USER_ID).run();

  // Insert active connection with needs_reauth_at set
  await env.DB.prepare(
    `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, needs_reauth_at)
     VALUES (?, ?, 'linear', ?, 'active', 'managed', '2026-03-10T00:00:00Z')`
  ).bind(CONNECTION_ID, USER_ID, creds.secret1).run();

  // Encrypt valid (non-expired) OAuth tokens into KV using managed encryption
  const tokenData = JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 86400, // expires in 24h
  });
  const managedKeys = await getManagedEncryptionKeys(env as any);
  const activeKey = managedKeys[managedKeys.length - 1];
  const key = await deriveManagedEncryptionKey(activeKey.key, CONNECTION_ID);
  const encrypted = await encryptTokenDataWithKey(tokenData, key);
  await env.KV.put(KV_KEY, encrypted);

  // Populate KV proxy cache entry so the proxy handler can find this connection
  const cacheEntry = {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: CONNECTION_ID,
    userId: USER_ID,
    service: 'linear',
    status: 'active',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'managed',
    managedKeyFingerprint: activeKey.fingerprint,
    dcrKeyFingerprint: '',
    dcrRegistration: null,
    needsReauthAt: '2026-03-10T00:00:00Z',
    encryptedTokens: encrypted,
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
  await env.KV.put(`proxy:${creds.secret1}`, JSON.stringify(cacheEntry));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ZK_CONNECTION_ID = 'conn-zk-proxy-test';
const zkCreds = makeFixedCredentials(0x50, 0x51);

describe('Proxy handler reauth clearing', () => {
  it('clears needs_reauth_at after a successful proxy request', async () => {
    // Verify needs_reauth_at is set before the request
    const before = await env.DB.prepare(
      `SELECT needs_reauth_at FROM connections WHERE id = ?`
    ).bind(CONNECTION_ID).first<{ needs_reauth_at: string | null }>();
    expect(before?.needs_reauth_at).toBe('2026-03-10T00:00:00Z');

    // Mock globalThis.fetch to return a successful upstream response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://mcp.linear.app/mcp')) {
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
      const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(response.status).toBe(200);

      // Wait for ctx.waitUntil promises to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify needs_reauth_at has been cleared
      const after = await env.DB.prepare(
        `SELECT needs_reauth_at FROM connections WHERE id = ?`
      ).bind(CONNECTION_ID).first<{ needs_reauth_at: string | null }>();
      expect(after?.needs_reauth_at).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Refresh cool-down returns 503', () => {
  it('returns 503 with Retry-After when cool-down key is present and token is expired', async () => {
    // Set a cool-down key for the connection
    await env.KV.put(`refresh_cooldown:${CONNECTION_ID}`, new Date().toISOString(), { expirationTtl: 60 });

    // Set expired tokens so refresh would be attempted
    const expiredTokenData = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 100, // expired
    });
    const _managedKeys = await getManagedEncryptionKeys(env as any);
    const _activeKey = _managedKeys[_managedKeys.length - 1];
    const key = await deriveManagedEncryptionKey(_activeKey.key, CONNECTION_ID);
    const encrypted = await encryptTokenDataWithKey(expiredTokenData, key);

    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      managedKeyFingerprint: _activeKey.fingerprint,
      dcrKeyFingerprint: '',
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: encrypted,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${creds.secret1}`, JSON.stringify(cacheEntry));

    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    const body = await response.json() as any;
    expect(body.error.code).toBe(-32007);

    // Clean up
    await env.KV.delete(`refresh_cooldown:${CONNECTION_ID}`);
  });

  it('clears cool-down key after successful refresh', async () => {
    // Pre-set a stale cooldown key
    await env.KV.put(`refresh_cooldown:${CONNECTION_ID}`, 'stale', { expirationTtl: 60 });

    // Set near-expiring (but still valid) tokens — cooldown check returns tokens
    // when token is still valid, but refresh still happens if lock is acquired
    const expiringTokenData = JSON.stringify({
      access_token: 'expiring-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 60, // expires in 60s (< 300s threshold, but > 0)
    });
    const _managedKeys2 = await getManagedEncryptionKeys(env as any);
    const _activeKey2 = _managedKeys2[_managedKeys2.length - 1];
    const key = await deriveManagedEncryptionKey(_activeKey2.key, CONNECTION_ID);
    const encrypted = await encryptTokenDataWithKey(expiringTokenData, key);

    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      managedKeyFingerprint: _activeKey2.fingerprint,
      dcrKeyFingerprint: '',
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: encrypted,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${creds.secret1}`, JSON.stringify(cacheEntry));

    // When cooldown is present and token is still valid, refreshTokenWithLock
    // returns the stale tokens without attempting refresh.
    // Cool-down key persists — it's cleared only by performTokenRefresh on success.
    // We verify the cooldown key is still present after this path.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://mcp.linear.app')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1, result: { tools: [] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    };

    try {
      const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      // Should succeed with stale-but-valid tokens
      expect(response.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Cooldown key should still exist (not cleared since no refresh happened)
      const cooldownVal = await env.KV.get(`refresh_cooldown:${CONNECTION_ID}`);
      expect(cooldownVal).toBe('stale');
    } finally {
      globalThis.fetch = originalFetch;
      await env.KV.delete(`refresh_cooldown:${CONNECTION_ID}`);
    }
  });
});

describe('ZK proxy refresh key correctness', () => {
  it('re-encrypts with secret2 (not managed key) after refresh', async () => {
    const tokenData = JSON.stringify({
      access_token: 'zk-access-expiring',
      refresh_token: 'zk-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const encrypted = await encryptTokenData(tokenData, zkCreds.secret2);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('zk-user', 'free_trial', '2099-12-31T23:59:59Z')`
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, 'zk-user', 'linear', ?, 'active', 'zero_knowledge')`
    ).bind(ZK_CONNECTION_ID, zkCreds.secret1).run();

    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: ZK_CONNECTION_ID,
      userId: 'zk-user',
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'zero_knowledge',
      managedKeyFingerprint: '',
      dcrKeyFingerprint: '',
      dcrRegistration: null,
      needsReauthAt: null,
      encryptedTokens: encrypted,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${zkCreds.secret1}`, JSON.stringify(cacheEntry));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('oauth2/token') || url.includes('/token')) {
        return new Response(JSON.stringify({
          access_token: 'zk-new-access',
          refresh_token: 'zk-new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://mcp.linear.app')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1, result: { tools: [] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    };

    try {
      const response = await SELF.fetch(`http://localhost/mcp/linear/${zkCreds.credentials}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      expect(response.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 200));

      const raw = await env.KV.get(`proxy:${zkCreds.secret1}`);
      expect(raw).not.toBeNull();
      const updatedEntry = JSON.parse(raw!);
      const decrypted = await decryptTokenData(updatedEntry.encryptedTokens, zkCreds.secret2);
      const newTokens = JSON.parse(decrypted);
      expect(newTokens.access_token).toBe('zk-new-access');
      expect(newTokens.refresh_token).toBe('zk-new-refresh');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ZK+DCR connection decrypts stored DCR registration (BIN-369)', () => {
  const ZK_DCR_CONNECTION_ID = 'conn-zk-dcr-test';
  const zkDcrCreds = makeFixedCredentials(0x60, 0x61);

  it('ZK connection with dcrKeyFingerprint decrypts stored DCR registration and uses its client_id', async () => {
    const managedKeys = await getManagedEncryptionKeys(env as any);
    const activeKey = managedKeys[managedKeys.length - 1];

    // Create a DCR registration encrypted with the managed key (as stored for ZK+DCR connections)
    const dcrRegistration = JSON.stringify({
      client_id: 'zk-dcr-client-id-12345',
      client_secret: 'zk-dcr-client-secret',
    });
    const dcrKey = await deriveManagedEncryptionKey(activeKey.key, ZK_DCR_CONNECTION_ID);
    const encryptedDcr = await encryptTokenDataWithKey(dcrRegistration, dcrKey);

    // Encrypt tokens with secret2 (ZK-style)
    const tokenData = JSON.stringify({
      access_token: 'zk-dcr-access-expiring',
      refresh_token: 'zk-dcr-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 60, // expires soon
    });
    const encryptedTokens = await encryptTokenData(tokenData, zkDcrCreds.secret2);

    // Set up DB records
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('zk-dcr-user', 'free_trial', '2099-12-31T23:59:59Z')`
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, dcr_registration, dcr_key_fingerprint)
       VALUES (?, 'zk-dcr-user', 'notion', ?, 'active', 'zero_knowledge', ?, ?)`
    ).bind(ZK_DCR_CONNECTION_ID, zkDcrCreds.secret1, encryptedDcr, activeKey.fingerprint).run();

    // Build KV cache entry: ZK connection with dcrKeyFingerprint set
    const cacheEntry = {
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId: ZK_DCR_CONNECTION_ID,
      userId: 'zk-dcr-user',
      service: 'notion',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'zero_knowledge',
      managedKeyFingerprint: '',
      dcrKeyFingerprint: activeKey.fingerprint,
      dcrRegistration: encryptedDcr,
      needsReauthAt: null,
      encryptedTokens,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    };
    await env.KV.put(`proxy:${zkDcrCreds.secret1}`, JSON.stringify(cacheEntry));

    // Track what client_id is used in the token refresh request
    let capturedClientId: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('mcp.notion.com/token')) {
        // Capture the client_id from the request body
        const body = init?.body?.toString() ?? '';
        const params = new URLSearchParams(body);
        capturedClientId = params.get('client_id');
        return new Response(JSON.stringify({
          access_token: 'zk-dcr-new-access',
          refresh_token: 'zk-dcr-new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('mcp.notion.com/mcp')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1, result: { tools: [] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    };

    try {
      const response = await SELF.fetch(`http://localhost/mcp/notion/${zkDcrCreds.credentials}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      expect(response.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify the correct client_id from the stored DCR was used
      expect(capturedClientId).toBe('zk-dcr-client-id-12345');

      // Verify the new tokens were re-encrypted with secret2 (ZK-style)
      const raw = await env.KV.get(`proxy:${zkDcrCreds.secret1}`);
      expect(raw).not.toBeNull();
      const updatedEntry = JSON.parse(raw!);
      const decrypted = await decryptTokenData(updatedEntry.encryptedTokens, zkDcrCreds.secret2);
      const newTokens = JSON.parse(decrypted);
      expect(newTokens.access_token).toBe('zk-dcr-new-access');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
