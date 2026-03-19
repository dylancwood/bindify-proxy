import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { detectOrphanedFingerprints, processRotationRequests } from '../rotation';
import {
  computeKeyFingerprint,
  parseManagedKeys,
  deriveManagedEncryptionKey,
  encryptTokenDataWithKey,
  decryptTokenDataWithKey,
} from '../crypto';
import type { ManagedKeyEntry } from '../crypto';
import { PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';

const MASTER_KEY_V1 = 'test-master-key-0123456789abcdef0123456789abcdef';
const MASTER_KEY_V2 = 'new-master-key-fedcba9876543210fedcba9876543210';
const MASTER_KEY_V3 = 'third-key-abcdef0123456789abcdef0123456789ab';

let FP_V1: string;
let FP_V2: string;
let FP_V3: string;
let KEYS_V1_ONLY: ManagedKeyEntry[];
let KEYS_V1_V2: ManagedKeyEntry[];

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
CREATE TABLE IF NOT EXISTS pending_key_rotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expected_fingerprints TEXT NOT NULL,
    new_key_hex TEXT NOT NULL,
    new_key_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
`;

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

beforeAll(async () => {
  FP_V1 = await computeKeyFingerprint(MASTER_KEY_V1);
  FP_V2 = await computeKeyFingerprint(MASTER_KEY_V2);
  FP_V3 = await computeKeyFingerprint(MASTER_KEY_V3);
  KEYS_V1_ONLY = await parseManagedKeys(JSON.stringify([{ key: MASTER_KEY_V1 }]));
  KEYS_V1_V2 = await parseManagedKeys(JSON.stringify([{ key: MASTER_KEY_V1 }, { key: MASTER_KEY_V2 }]));

  const statements = SCHEMA.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  await env.DB
    .prepare("INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('user1', 'free_trial', '2099-12-31T23:59:59Z')")
    .run();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.prepare('DELETE FROM pending_key_rotations').run();
  await env.DB.prepare('DELETE FROM connections').run();

  // Clear KV proxy keys
  const keys = await env.KV.list({ prefix: 'proxy:' });
  for (const key of keys.keys) {
    await env.KV.delete(key.name);
  }
});

// ─── detectOrphanedFingerprints (existing tests preserved) ───

describe('detectOrphanedFingerprints', () => {
  it('logs error when D1 has fingerprint not in config', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: 'orphaned1234abcd' }],
        }),
      }),
    };
    const configFingerprints = ['configured12345a'];
    const mockLogger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, configFingerprints, mockLogger as any);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('orphaned1234abcd')
    );
  });

  it('does not log when all fingerprints match', async () => {
    const fp = 'configured12345a';
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: fp }],
        }),
      }),
    };
    const mockLogger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, [fp], mockLogger as any);

    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('ignores empty key_fingerprint rows (ZK connections)', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: '' }],
        }),
      }),
    };
    const mockLogger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, ['configured12345a'], mockLogger as any);

    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// ─── processRotationRequests: Validation phase ───

describe('processRotationRequests - validation phase', () => {
  it('sets status to validated when fingerprints match and new key is new', async () => {
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) VALUES (?, ?, ?)"
      )
      .bind(JSON.stringify([FP_V1]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_ONLY, logger);

    const row = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(row.status).toBe('validated');
    const result = JSON.parse(row.result);
    expect(result.phase).toBe('validated');
    expect(result.message).toContain('Proceed with wrangler secret put');
  });

  it('sets status to failed when expected fingerprints do not match config', async () => {
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) VALUES (?, ?, ?)"
      )
      .bind(JSON.stringify(['wrong_fingerprint']), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_ONLY, logger);

    const row = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(row.status).toBe('failed');
    const result = JSON.parse(row.result);
    expect(result.phase).toBe('validation');
    expect(result.error).toBe('Fingerprint mismatch');
    expect(result.expected).toEqual(['wrong_fingerprint']);
    expect(result.actual).toEqual([FP_V1]);
  });

  it('sets status to rejected when new key fingerprint already exists in config', async () => {
    // New key fingerprint is FP_V1, which already exists in KEYS_V1_ONLY
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) VALUES (?, ?, ?)"
      )
      .bind(JSON.stringify([FP_V1]), 'some_hex', FP_V1)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_ONLY, logger);

    const row = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(row.status).toBe('rejected');
    const result = JSON.parse(row.result);
    expect(result.error).toContain('already exists');
    expect(result.fingerprint).toBe(FP_V1);
  });

  it('processes only the oldest pending row when multiple exist', async () => {
    // Insert two pending rows
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) VALUES (?, ?, ?)"
      )
      .bind(JSON.stringify([FP_V1]), MASTER_KEY_V2, FP_V2)
      .run();

    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) VALUES (?, ?, ?)"
      )
      .bind(JSON.stringify([FP_V1]), MASTER_KEY_V3, FP_V3)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_ONLY, logger);

    const rows = await env.DB.prepare('SELECT * FROM pending_key_rotations ORDER BY id ASC').all<any>();
    expect(rows.results[0].status).toBe('validated');
    expect(rows.results[1].status).toBe('pending'); // Second row untouched
  });
});

// ─── processRotationRequests: Migration phase ───

describe('processRotationRequests - migration phase', () => {
  async function insertConnection(
    id: string,
    secret1: string,
    tokenData: string,
    fingerprint: string,
    opts?: { dcrData?: string }
  ) {
    const masterKey = fingerprint === FP_V1 ? MASTER_KEY_V1 : MASTER_KEY_V2;
    const cryptoKey = await deriveManagedEncryptionKey(masterKey, id);
    const encryptedTokens = await encryptTokenDataWithKey(tokenData, cryptoKey);
    let dcrRegistration: string | null = null;
    if (opts?.dcrData) {
      dcrRegistration = await encryptTokenDataWithKey(opts.dcrData, cryptoKey);
    }

    await env.DB
      .prepare(
        `INSERT INTO connections (id, user_id, service, secret_url_segment_1, key_storage_mode, key_fingerprint, encrypted_tokens, dcr_registration)
         VALUES (?, 'user1', 'linear', ?, 'managed', ?, ?, ?)`
      )
      .bind(id, secret1, fingerprint, encryptedTokens, dcrRegistration)
      .run();

    return { encryptedTokens, dcrRegistration };
  }

  function makeKvEntry(connectionId: string, encryptedTokens: string, fingerprint: string, opts?: { dcrRegistration?: string | null }) {
    return JSON.stringify({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      connectionId,
      userId: 'user1',
      service: 'linear',
      status: 'active',
      authType: 'oauth',
      authMode: null,
      application: null,
      keyStorageMode: 'managed',
      keyFingerprint: fingerprint,
      dcrRegistration: opts?.dcrRegistration ?? null,
      needsReauthAt: null,
      encryptedTokens,
      user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
      subscriptionStatus: null,
      subscriptionPastDueSince: null,
      cachedAt: new Date().toISOString(),
    });
  }

  it('re-encrypts all managed connections to new key, updates key_fingerprint in D1 and KV', async () => {
    const tokenData = JSON.stringify({ access_token: 'tok1', refresh_token: 'ref1', expires_at: 9999 });
    const { encryptedTokens } = await insertConnection('conn1', 'secret1', tokenData, FP_V1);
    await env.KV.put('proxy:secret1', makeKvEntry('conn1', encryptedTokens, FP_V1));

    // Insert a migrate row
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    // Check D1
    const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('conn1').first<any>();
    expect(conn.key_fingerprint).toBe(FP_V2);

    // Decrypt with new key to verify
    const newCryptoKey = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn1');
    const decrypted = await decryptTokenDataWithKey(conn.encrypted_tokens, newCryptoKey);
    expect(JSON.parse(decrypted).access_token).toBe('tok1');

    // Check KV
    const kvRaw = await env.KV.get('proxy:secret1');
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.keyFingerprint).toBe(FP_V2);
    const kvDecrypted = await decryptTokenDataWithKey(kvEntry.encryptedTokens, newCryptoKey);
    expect(JSON.parse(kvDecrypted).access_token).toBe('tok1');

    // Check rotation row
    const rotRow = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(rotRow.status).toBe('completed');
    const result = JSON.parse(rotRow.result);
    expect(result.phase).toBe('migrated');
    expect(result.migrated).toBe(1);
  });

  it('skips already-migrated connections', async () => {
    const tokenData = JSON.stringify({ access_token: 'tok2', refresh_token: 'ref2', expires_at: 9999 });
    // This connection already has FP_V2 (active key), so it won't be picked up by the query
    await insertConnection('conn-already', 'secret-already', tokenData, FP_V2);

    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    const rotRow = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(rotRow.status).toBe('completed');
    const result = JSON.parse(rotRow.result);
    expect(result.migrated).toBe(0);
    expect(result.connectionCounts.total).toBe(0);
  });

  it('reports individual connection errors without aborting', async () => {
    // Insert one valid connection and one with null encrypted_tokens
    const tokenData = JSON.stringify({ access_token: 'tok3', refresh_token: 'ref3', expires_at: 9999 });
    await insertConnection('conn-good', 'secret-good', tokenData, FP_V1);

    // Insert a connection with null encrypted_tokens manually
    await env.DB
      .prepare(
        `INSERT INTO connections (id, user_id, service, secret_url_segment_1, key_storage_mode, key_fingerprint, encrypted_tokens)
         VALUES ('conn-bad', 'user1', 'linear', 'secret-bad', 'managed', ?, NULL)`
      )
      .bind(FP_V1)
      .run();

    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    const rotRow = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(rotRow.status).toBe('completed');
    const result = JSON.parse(rotRow.result);
    expect(result.migrated).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].connectionId).toBe('conn-bad');

    // Good connection was still migrated
    const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('conn-good').first<any>();
    expect(conn.key_fingerprint).toBe(FP_V2);
  });

  it('handles missing KV entry gracefully', async () => {
    const tokenData = JSON.stringify({ access_token: 'tok4', refresh_token: 'ref4', expires_at: 9999 });
    await insertConnection('conn-no-kv', 'secret-no-kv', tokenData, FP_V1);
    // Deliberately do NOT write a KV entry

    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    // D1 should still be updated
    const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('conn-no-kv').first<any>();
    expect(conn.key_fingerprint).toBe(FP_V2);

    // Migration should succeed without errors
    const rotRow = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    const result = JSON.parse(rotRow.result);
    expect(result.migrated).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it('re-encrypts DCR registrations alongside tokens', async () => {
    const tokenData = JSON.stringify({ access_token: 'tok5', refresh_token: 'ref5', expires_at: 9999 });
    const dcrData = JSON.stringify({ client_id: 'dcr-client', client_secret: 'dcr-secret' });
    const { encryptedTokens, dcrRegistration } = await insertConnection(
      'conn-dcr', 'secret-dcr', tokenData, FP_V1, { dcrData }
    );
    await env.KV.put('proxy:secret-dcr', makeKvEntry('conn-dcr', encryptedTokens, FP_V1, { dcrRegistration }));

    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    // Verify D1 DCR re-encrypted
    const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('conn-dcr').first<any>();
    expect(conn.key_fingerprint).toBe(FP_V2);
    expect(conn.dcr_registration).not.toBeNull();

    const newCryptoKey = await deriveManagedEncryptionKey(MASTER_KEY_V2, 'conn-dcr');
    const decryptedDcr = await decryptTokenDataWithKey(conn.dcr_registration, newCryptoKey);
    expect(JSON.parse(decryptedDcr).client_id).toBe('dcr-client');

    // Verify KV DCR re-encrypted
    const kvRaw = await env.KV.get('proxy:secret-dcr');
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.dcrRegistration).not.toBeNull();
    const kvDecryptedDcr = await decryptTokenDataWithKey(kvEntry.dcrRegistration, newCryptoKey);
    expect(JSON.parse(kvDecryptedDcr).client_secret).toBe('dcr-secret');
  });

  it('scrubs new_key_hex after completion', async () => {
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, ?, ?, 'migrate')"
      )
      .bind(JSON.stringify([FP_V1, FP_V2]), MASTER_KEY_V2, FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_V2, logger);

    const rotRow = await env.DB.prepare('SELECT * FROM pending_key_rotations LIMIT 1').first<any>();
    expect(rotRow.status).toBe('completed');
    expect(rotRow.new_key_hex).toBe('');
  });
});

// ─── processRotationRequests: Cleanup phase ───

describe('processRotationRequests - cleanup phase', () => {
  it('deletes rotation rows older than 30 days with terminal status', async () => {
    // Insert a completed row with old created_at
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status, created_at) VALUES (?, '', ?, 'completed', datetime('now', '-31 days'))"
      )
      .bind(JSON.stringify([FP_V1]), FP_V2)
      .run();

    // Insert a failed row with old created_at
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status, created_at) VALUES (?, '', ?, 'failed', datetime('now', '-31 days'))"
      )
      .bind(JSON.stringify([FP_V1]), FP_V3)
      .run();

    // Insert a rejected row with old created_at
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status, created_at) VALUES (?, '', ?, 'rejected', datetime('now', '-31 days'))"
      )
      .bind(JSON.stringify([FP_V1]), FP_V3)
      .run();

    // Insert a recent completed row (should NOT be deleted)
    await env.DB
      .prepare(
        "INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint, status) VALUES (?, '', ?, 'completed')"
      )
      .bind(JSON.stringify([FP_V1]), FP_V2)
      .run();

    await processRotationRequests(env.DB, env.KV, KEYS_V1_ONLY, logger);

    const rows = await env.DB.prepare('SELECT * FROM pending_key_rotations').all<any>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].status).toBe('completed');
    // The remaining row should be the recent one
  });
});
