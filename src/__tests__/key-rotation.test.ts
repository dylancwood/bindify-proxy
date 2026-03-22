import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  deriveManagedEncryptionKey,
  encryptTokenDataWithKey,
  decryptTokenDataWithKey,
  parseManagedKeys,
  getManagedKey,
  getActiveKey,
  getManagedKeyWithFallback,
  computeKeyFingerprint,
} from '../crypto';
import { decryptCacheTokens, PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';
import type { ProxyCacheEntry } from '../proxy/kv-cache';

const MASTER_KEY_V1 = 'test-master-key-0123456789abcdef0123456789abcdef';
const MASTER_KEY_V2 = 'new-master-key-fedcba9876543210fedcba9876543210';

// Fingerprints are computed at parse time; we also compute them here for assertions
let FP_V1: string;
let FP_V2: string;

// Parsed key arrays (async — populated in beforeAll)
let KEYS_V1_ONLY: Awaited<ReturnType<typeof parseManagedKeys>>;
let KEYS_V1_V2: Awaited<ReturnType<typeof parseManagedKeys>>;

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
`;

function makeCacheEntry(connectionId: string, encryptedTokens: string, opts?: { managedKeyFingerprint?: string; dcrKeyFingerprint?: string; keyStorageMode?: 'managed' | 'zero_knowledge' }): ProxyCacheEntry {
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
    managedKeyFingerprint: opts?.managedKeyFingerprint ?? FP_V1,
    dcrKeyFingerprint: opts?.dcrKeyFingerprint ?? '',
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
  FP_V1 = await computeKeyFingerprint(MASTER_KEY_V1);
  FP_V2 = await computeKeyFingerprint(MASTER_KEY_V2);
  KEYS_V1_ONLY = await parseManagedKeys(JSON.stringify([{ key: MASTER_KEY_V1 }]));
  KEYS_V1_V2 = await parseManagedKeys(JSON.stringify([{ key: MASTER_KEY_V1 }, { key: MASTER_KEY_V2 }]));

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

describe('Fingerprint-based key encrypt/decrypt', () => {
  it('encrypts with key1 and decrypts with key1', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn1');
    const data = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);
    const decrypted = await decryptTokenDataWithKey(encrypted, key);
    expect(decrypted).toBe(data);
  });

  it('key1-encrypted data cannot be decrypted with key2', async () => {
    const keyV1 = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn1');
    const keyV2 = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn1');
    const data = JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, keyV1);
    await expect(decryptTokenDataWithKey(encrypted, keyV2)).rejects.toThrow();
  });
});

describe('decryptCacheTokens with fingerprint-based keys', () => {
  it('cache entry with key1 fingerprint decrypts with key1', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V1, 'conn-cache-v1');
    const data = JSON.stringify({ access_token: 'tok-v1', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const entry = makeCacheEntry('conn-cache-v1', encrypted, { managedKeyFingerprint: FP_V1 });
    const result = await decryptCacheTokens(entry, 'unused', KEYS_V1_V2);
    expect((result as any).access_token).toBe('tok-v1');
  });

  it('cache entry with key2 fingerprint decrypts with key2', async () => {
    const key = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn-cache-v2');
    const data = JSON.stringify({ access_token: 'tok-v2', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const entry = makeCacheEntry('conn-cache-v2', encrypted, { managedKeyFingerprint: FP_V2 });
    const result = await decryptCacheTokens(entry, 'unused', KEYS_V1_V2);
    expect((result as any).access_token).toBe('tok-v2');
  });
});

describe('Multi-key backward compatibility', () => {
  it('key1-encrypted data still decrypts when key2 is active', async () => {
    const masterKeyV1 = getManagedKey(KEYS_V1_V2, FP_V1);
    const key = await deriveManagedEncryptionKey(masterKeyV1, 'conn-compat');
    const data = JSON.stringify({ access_token: 'old-tok', refresh_token: 'ref', expires_at: 9999 });
    const encrypted = await encryptTokenDataWithKey(data, key);

    const resolvedKey = getManagedKey(KEYS_V1_V2, FP_V1);
    expect(resolvedKey).toBe(MASTER_KEY_V1);
    const derivedKey = await deriveManagedEncryptionKey(resolvedKey, 'conn-compat');
    const decrypted = await decryptTokenDataWithKey(encrypted, derivedKey);
    expect(JSON.parse(decrypted).access_token).toBe('old-tok');

    const active = getActiveKey(KEYS_V1_V2);
    expect(active.fingerprint).toBe(FP_V2);
  });
});

describe('getManagedKeyWithFallback', () => {
  it('returns the matching key when fingerprint is found', () => {
    const result = getManagedKeyWithFallback(KEYS_V1_V2, FP_V1, 'conn-1');
    expect(result).toBe(MASTER_KEY_V1);
  });

  it('returns active key with WARN when fingerprint is not found', () => {
    const result = getManagedKeyWithFallback(KEYS_V1_V2, 'fp-unknown', 'conn-2');
    expect(result).toBe(MASTER_KEY_V2);
  });

  it('returns active key with WARN when fingerprint is empty', () => {
    const result = getManagedKeyWithFallback(KEYS_V1_V2, '', 'conn-3');
    expect(result).toBe(MASTER_KEY_V2);
  });
});

describe('Migration script', () => {
  // The rotateKeys function will be completely rewritten in Task 12.
  // These tests are marked as .todo() until then.
  it.todo('re-encrypts all managed connections and KV entries');
  it.todo('skips ZK connections');
  it.todo('skips already-migrated connections');
  it.todo('re-encrypts DCR registrations');
  it.todo('handles missing KV entry gracefully');
});
