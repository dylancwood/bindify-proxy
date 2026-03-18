import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  deriveManagedEncryptionKey,
  encryptTokenDataWithKey,
  decryptTokenDataWithKey,
  parseManagedKeys,
  getManagedKey,
  getActiveKeyVersion,
} from '../crypto';
import { decryptCacheTokens, PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';
import type { ProxyCacheEntry } from '../proxy/kv-cache';
import { rotateKeys } from '../scripts/rotate-keys';

const MASTER_KEY_V1 = 'test-master-key-0123456789abcdef0123456789abcdef';
const MASTER_KEY_V2 = 'new-master-key-fedcba9876543210fedcba9876543210';
const KEYS_V1_ONLY = [{ version: 1, key: MASTER_KEY_V1 }];
const KEYS_V1_V2 = [{ version: 1, key: MASTER_KEY_V1 }, { version: 2, key: MASTER_KEY_V2 }];

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
CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
`;

function makeCacheEntry(connectionId: string, encryptedTokens: string, opts?: { keyVersion?: number; keyStorageMode?: 'managed' | 'zero_knowledge' }): ProxyCacheEntry {
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId,
    userId: 'user1',
    service: 'linear',
    status: 'active',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: opts?.keyStorageMode ?? 'managed',
    keyVersion: opts?.keyVersion ?? 1,
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens,
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('user1', 'free_trial', '2099-12-31T23:59:59Z')").run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM connection_events').run();
  await env.DB.prepare('DELETE FROM connections').run();
});

describe('Versioned key encrypt/decrypt', () => {
  it('encrypts with v1 and decrypts with v1', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn1');
    const data = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);
    const decrypted = await decryptTokenDataWithKey(encrypted, key);
    expect(decrypted).toBe(data);
  });

  it('v1-encrypted data cannot be decrypted with v2 key', async () => {
    const keyV1 = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn1');
    const keyV2 = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn1');
    const data = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, keyV1);
    await expect(decryptTokenDataWithKey(encrypted, keyV2)).rejects.toThrow();
  });
});

describe('decryptCacheTokens with versioned keys', () => {
  it('v1 cache entry decrypts with v1 key', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn-cache-v1');
    const data = JSON.stringify({ access_token: 'tok-v1', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const entry = makeCacheEntry('conn-cache-v1', encrypted, { keyVersion: 1 });
    const result = await decryptCacheTokens(entry, 'unused', KEYS_V1_V2);
    expect((result as any).access_token).toBe('tok-v1');
  });

  it('v2 cache entry decrypts with v2 key', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn-cache-v2');
    const data = JSON.stringify({ access_token: 'tok-v2', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const entry = makeCacheEntry('conn-cache-v2', encrypted, { keyVersion: 2 });
    const result = await decryptCacheTokens(entry, 'unused', KEYS_V1_V2);
    expect((result as any).access_token).toBe('tok-v2');
  });
});

describe('Multi-key backward compatibility', () => {
  it('v1-encrypted data still decrypts when v2 is active', async () => {
    const masterKeyV1 = getManagedKey(KEYS_V1_V2, 1);
    const key = await deriveManagedEncryptionKey(masterKeyV1, 'conn-compat');
    const data = JSON.stringify({ access_token: 'old-tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const resolvedKey = getManagedKey(KEYS_V1_V2, 1);
    expect(resolvedKey).toBe(MASTER_KEY_V1);
    const derivedKey = await deriveManagedEncryptionKey(resolvedKey, 'conn-compat');
    const decrypted = await decryptTokenDataWithKey(encrypted, derivedKey);
    expect(JSON.parse(decrypted).access_token).toBe('old-tok');

    const active = getActiveKeyVersion(KEYS_V1_V2);
    expect(active.version).toBe(2);
  });
});

describe('Migration script', () => {
  async function seedConnection(id: string, secret1: string, opts?: { keyVersion?: number; dcrRegistration?: string | null; keyStorageMode?: string }) {
    const keyVersion = opts?.keyVersion ?? 1;
    const masterKey = getManagedKey(KEYS_V1_V2, keyVersion);
    const key = await deriveManagedEncryptionKey(masterKey, id);
    const tokens = JSON.stringify({ access_token: `tok-${id}`, refresh_token: `ref-${id}`, expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(tokens, key);

    let encDcr: string | null = null;
    if (opts?.dcrRegistration) {
      encDcr = await encryptTokenDataWithKey(opts.dcrRegistration, key);
    }

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, encrypted_tokens, dcr_registration, key_version)
       VALUES (?, 'user1', 'linear', ?, 'active', ?, 'oauth', ?, ?, ?)`
    ).bind(id, secret1, opts?.keyStorageMode ?? 'managed', encrypted, encDcr, keyVersion).run();

    const cacheEntry = makeCacheEntry(id, encrypted, { keyVersion });
    if (encDcr) cacheEntry.dcrRegistration = encDcr;
    await env.KV.put(`proxy:${secret1}`, JSON.stringify(cacheEntry));

    return encrypted;
  }

  it('re-encrypts all managed connections and KV entries', async () => {
    await seedConnection('conn-a', 's1-a');
    await seedConnection('conn-b', 's1-b');
    await seedConnection('conn-c', 's1-c');

    const rotateEnv = {
      DB: env.DB,
      KV: env.KV,
      MANAGED_ENCRYPTION_KEYS: JSON.stringify(KEYS_V1_V2),
    };

    const result = await rotateKeys(rotateEnv);
    expect(result.migrated).toBe(3);
    expect(result.errors).toHaveLength(0);

    for (const id of ['conn-a', 'conn-b', 'conn-c']) {
      const row = await env.DB.prepare('SELECT encrypted_tokens, key_version FROM connections WHERE id = ?')
        .bind(id).first<{ encrypted_tokens: string; key_version: number }>();
      expect(row!.key_version).toBe(2);

      const keyV2 = await deriveManagedEncryptionKey(MASTER_KEY_V2, id);
      const decrypted = JSON.parse(await decryptTokenDataWithKey(row!.encrypted_tokens, keyV2));
      expect(decrypted.access_token).toBe(`tok-${id}`);
    }

    for (const [s1, id] of [['s1-a', 'conn-a'], ['s1-b', 'conn-b'], ['s1-c', 'conn-c']] as const) {
      const raw = await env.KV.get(`proxy:${s1}`);
      const entry = JSON.parse(raw!) as ProxyCacheEntry;
      expect(entry.keyVersion).toBe(2);

      const keyV2 = await deriveManagedEncryptionKey(MASTER_KEY_V2, id);
      const decrypted = JSON.parse(await decryptTokenDataWithKey(entry.encryptedTokens, keyV2));
      expect(decrypted.access_token).toBe(`tok-${id}`);
    }
  });

  it('skips ZK connections', async () => {
    await seedConnection('conn-zk', 's1-zk', { keyStorageMode: 'zero_knowledge' });

    const rotateEnv = {
      DB: env.DB,
      KV: env.KV,
      MANAGED_ENCRYPTION_KEYS: JSON.stringify(KEYS_V1_V2),
    };

    const result = await rotateKeys(rotateEnv);
    expect(result.migrated).toBe(0);

    const row = await env.DB.prepare('SELECT key_version FROM connections WHERE id = ?')
      .bind('conn-zk').first<{ key_version: number }>();
    expect(row!.key_version).toBe(1);
  });

  it('skips already-migrated connections', async () => {
    await seedConnection('conn-v2', 's1-v2', { keyVersion: 2 });

    const rotateEnv = {
      DB: env.DB,
      KV: env.KV,
      MANAGED_ENCRYPTION_KEYS: JSON.stringify(KEYS_V1_V2),
    };

    const result = await rotateKeys(rotateEnv);
    expect(result.migrated).toBe(0);
  });

  it('re-encrypts DCR registrations', async () => {
    const dcrData = JSON.stringify({ client_id: 'dcr-client-123', client_secret: 'dcr-secret' });
    await seedConnection('conn-dcr', 's1-dcr', { dcrRegistration: dcrData });

    const rotateEnv = {
      DB: env.DB,
      KV: env.KV,
      MANAGED_ENCRYPTION_KEYS: JSON.stringify(KEYS_V1_V2),
    };

    const result = await rotateKeys(rotateEnv);
    expect(result.migrated).toBe(1);

    const row = await env.DB.prepare('SELECT dcr_registration, key_version FROM connections WHERE id = ?')
      .bind('conn-dcr').first<{ dcr_registration: string; key_version: number }>();
    expect(row!.key_version).toBe(2);

    const keyV2 = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn-dcr');
    const decrypted = JSON.parse(await decryptTokenDataWithKey(row!.dcr_registration, keyV2));
    expect(decrypted.client_id).toBe('dcr-client-123');
  });

  it('handles missing KV entry gracefully', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn-no-kv');
    const tokens = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(tokens, key);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, encrypted_tokens, key_version)
       VALUES ('conn-no-kv', 'user1', 'linear', 's1-no-kv', 'active', 'managed', 'oauth', ?, 1)`
    ).bind(encrypted).run();

    const rotateEnv = {
      DB: env.DB,
      KV: env.KV,
      MANAGED_ENCRYPTION_KEYS: JSON.stringify(KEYS_V1_V2),
    };

    const result = await rotateKeys(rotateEnv);
    expect(result.migrated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = await env.DB.prepare('SELECT key_version FROM connections WHERE id = ?')
      .bind('conn-no-kv').first<{ key_version: number }>();
    expect(row!.key_version).toBe(2);
  });
});
