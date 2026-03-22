import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkKvD1Consistency } from '../consistency';
import { buildProxyCacheEntry, writeProxyCache, PROXY_CACHE_SCHEMA_VERSION, type ProxyCacheEntry } from '../proxy/kv-cache';
import { createUser, createConnection } from '../db/queries';
import type { Connection, User } from '@bindify/types';

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

CREATE TABLE IF NOT EXISTS anomaly_reports (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    anomaly_type TEXT NOT NULL,
    rectified INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_reports_connection_id ON anomaly_reports(connection_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_reports_unacknowledged ON anomaly_reports(created_at) WHERE acknowledged_at IS NULL;
`;

const USER_ID = 'consistency-user';
const TRIAL_END = '2099-12-31T23:59:59Z';

function makeConnection(overrides: Partial<Connection> & { id: string; secret_url_segment_1: string }): Parameters<typeof createConnection>[1] {
  return {
    user_id: USER_ID,
    service: 'linear',
    status: 'active',
    key_storage_mode: 'managed',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    dcr_registration: null,
    encrypted_tokens: 'encrypted-data',
    needs_reauth_at: null,
    ...overrides,
  };
}

function makeUser(): User {
  return {
    id: USER_ID,
    stripe_customer_id: null,
    plan: 'active',
    trial_ends_at: null,
    access_until: null,
    email: null,
    created_at: '',
  };
}

function makeConnectionObj(overrides: Partial<Connection> & { id: string; secret_url_segment_1: string }): Connection {
  return {
    user_id: USER_ID,
    service: 'linear',
    status: 'active',
    key_storage_mode: 'managed',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    label: null,
    dcr_registration: null,
    encrypted_tokens: 'encrypted-data',
    key_version: 0,
    key_fingerprint: '',
    managed_key_fingerprint: '',
    dcr_key_fingerprint: '',
    needs_reauth_at: null,
    last_used_at: null,
    last_refreshed_at: null,
    suspended_at: null,
    metadata: null,
    created_at: '',
    ...overrides,
  };
}

beforeAll(async () => {
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM anomaly_reports').run();
  await env.DB.prepare('DELETE FROM subscriptions').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();

  // Clear KV proxy keys
  const keys = await env.KV.list({ prefix: 'proxy:' });
  for (const key of keys.keys) {
    await env.KV.delete(key.name);
  }

  // Create user with 'active' plan
  await env.DB.prepare(
    "INSERT INTO users (id, plan, trial_ends_at) VALUES (?, 'active', ?)"
  ).bind(USER_ID, TRIAL_END).run();
});

describe('checkKvD1Consistency', () => {
  it('rectifies missing KV cache for active connection', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-missing-kv',
      secret_url_segment_1: 'secret-missing',
      encrypted_tokens: 'encrypted-data',
    }));

    const result = await checkKvD1Consistency(env);

    expect(result.checked).toBe(1);
    expect(result.rectified).toBe(1);
    expect(result.unrectifiable).toBe(0);

    // Verify KV was written
    const kvRaw = await env.KV.get('proxy:secret-missing');
    expect(kvRaw).not.toBeNull();
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.connectionId).toBe('conn-missing-kv');
    expect(kvEntry.encryptedTokens).toBe('encrypted-data');

    // Verify anomaly was reported
    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-missing-kv'"
    ).first();
    expect(anomaly).toBeTruthy();
    expect(anomaly!.anomaly_type).toBe('missing_kv_cache');
    expect(anomaly!.rectified).toBe(1);
  });

  it('rectifies stale KV data (keyFingerprint mismatch)', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-stale',
      secret_url_segment_1: 'secret-stale',
      encrypted_tokens: 'encrypted-data',
      key_fingerprint: 'fp-new',
    }));
    // Update key_fingerprint in D1
    await env.DB.prepare('UPDATE connections SET key_fingerprint = ? WHERE id = ?').bind('fp-new', 'conn-stale').run();

    // Write a stale KV entry with old fingerprint
    const staleEntry = buildProxyCacheEntry(
      makeConnectionObj({ id: 'conn-stale', secret_url_segment_1: 'secret-stale', key_fingerprint: 'fp-old' }),
      makeUser(),
      null,
      null,
      'encrypted-data',
    );
    await writeProxyCache(env, 'secret-stale', staleEntry);

    const result = await checkKvD1Consistency(env);

    expect(result.rectified).toBe(1);

    // Verify KV was updated
    const kvRaw = await env.KV.get('proxy:secret-stale');
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.keyFingerprint).toBe('fp-new');

    // Verify anomaly was reported
    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-stale'"
    ).first();
    expect(anomaly!.anomaly_type).toBe('stale_kv_data');
    expect(anomaly!.rectified).toBe(1);
  });

  it('reports unrectifiable anomaly for managed connection with null encrypted_tokens', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-corrupted',
      secret_url_segment_1: 'secret-corrupted',
      encrypted_tokens: null,
      key_storage_mode: 'managed',
    }));

    const result = await checkKvD1Consistency(env);

    expect(result.checked).toBe(1);
    expect(result.unrectifiable).toBe(1);
    expect(result.rectified).toBe(0);

    // Verify anomaly was reported
    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-corrupted'"
    ).first();
    expect(anomaly).toBeTruthy();
    expect(anomaly!.anomaly_type).toBe('corrupted_tokens');
    expect(anomaly!.rectified).toBe(0);

    // Verify KV was NOT written (no tokens to rebuild)
    const kvRaw = await env.KV.get('proxy:secret-corrupted');
    expect(kvRaw).toBeNull();
  });

  it('does NOT report corrupted_tokens for zero_knowledge connections with null encrypted_tokens', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-zk',
      secret_url_segment_1: 'secret-zk',
      encrypted_tokens: null,
      key_storage_mode: 'zero_knowledge',
    }));

    const result = await checkKvD1Consistency(env);

    expect(result.checked).toBe(1);
    expect(result.unrectifiable).toBe(0);

    // Should not have a corrupted_tokens anomaly
    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-zk' AND anomaly_type = 'corrupted_tokens'"
    ).first();
    expect(anomaly).toBeNull();

    // But missing KV should be rectified (with empty tokens for ZK)
    expect(result.rectified).toBe(1);
    const kvRaw = await env.KV.get('proxy:secret-zk');
    expect(kvRaw).not.toBeNull();
  });

  it('reports unrectifiable anomaly for stale managed refresh', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await createConnection(env.DB, makeConnection({
      id: 'conn-stale-refresh',
      secret_url_segment_1: 'secret-stale-refresh',
      encrypted_tokens: 'encrypted-data',
      key_storage_mode: 'managed',
    }));
    // Set last_refreshed_at to 5 days ago (> 4 * 1440 min = 4 days)
    await env.DB.prepare('UPDATE connections SET last_refreshed_at = ? WHERE id = ?')
      .bind(fiveDaysAgo, 'conn-stale-refresh').run();

    const result = await checkKvD1Consistency(env);

    expect(result.unrectifiable).toBeGreaterThanOrEqual(1);

    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-stale-refresh' AND anomaly_type = 'stale_managed_refresh'"
    ).first();
    expect(anomaly).toBeTruthy();
    expect(anomaly!.rectified).toBe(0);
  });

  it('skips KV lookup for suspended connections', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-suspended',
      secret_url_segment_1: 'secret-suspended',
      status: 'suspended',
      encrypted_tokens: 'encrypted-data',
    }));

    // Write a KV entry so we can verify it's NOT touched
    const entry = buildProxyCacheEntry(
      makeConnectionObj({ id: 'conn-suspended', secret_url_segment_1: 'secret-suspended', status: 'suspended' }),
      makeUser(),
      null,
      null,
      'encrypted-data',
    );
    await writeProxyCache(env, 'secret-suspended', entry);

    const result = await checkKvD1Consistency(env);

    expect(result.checked).toBe(1);
    // Suspended connections are checked (counted) but no KV lookup/rectification
    expect(result.rectified).toBe(0);
  });

  it('does not create duplicate anomalies when run twice', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-dedup',
      secret_url_segment_1: 'secret-dedup',
      encrypted_tokens: 'encrypted-data',
    }));

    // Run consistency check twice
    await checkKvD1Consistency(env);

    // Delete KV so second run sees missing cache again
    await env.KV.delete('proxy:secret-dedup');

    await checkKvD1Consistency(env);

    // Should only have one anomaly of this type
    const anomalies = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-dedup' AND anomaly_type = 'missing_kv_cache'"
    ).all();
    expect(anomalies.results.length).toBe(1);
  });

  it('includes subscription data in KV rebuild', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-sub',
      secret_url_segment_1: 'secret-sub',
      encrypted_tokens: 'encrypted-data',
    }));
    // Add a subscription
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, quantity, status, current_period_end, past_due_since)
       VALUES ('sub-1', ?, 1, 'past_due', '2099-12-31T23:59:59Z', '2026-03-10T00:00:00Z')`
    ).bind(USER_ID).run();

    const result = await checkKvD1Consistency(env);

    expect(result.rectified).toBe(1);

    // Verify subscription data in KV
    const kvRaw = await env.KV.get('proxy:secret-sub');
    const kvEntry: ProxyCacheEntry = JSON.parse(kvRaw!);
    expect(kvEntry.subscriptionStatus).toBe('past_due');
    expect(kvEntry.subscriptionPastDueSince).toBe('2026-03-10T00:00:00Z');
    expect(kvEntry.user.plan).toBe('active');
  });

  it('rectifies tombstone for active connection', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-tombstone',
      secret_url_segment_1: 'secret-tombstone',
      encrypted_tokens: 'encrypted-data',
    }));

    // Write a tombstone to KV
    await env.KV.put('proxy:secret-tombstone', JSON.stringify({ schemaVersion: 0, deleted: true }));

    const result = await checkKvD1Consistency(env);

    expect(result.rectified).toBe(1);

    const kvRaw = await env.KV.get('proxy:secret-tombstone');
    const kvEntry = JSON.parse(kvRaw!);
    expect(kvEntry.schemaVersion).toBe(PROXY_CACHE_SCHEMA_VERSION);
    expect(kvEntry.connectionId).toBe('conn-tombstone');

    const anomaly = await env.DB.prepare(
      "SELECT * FROM anomaly_reports WHERE connection_id = 'conn-tombstone'"
    ).first();
    expect(anomaly!.anomaly_type).toBe('stale_kv_data');
    expect(anomaly!.rectified).toBe(1);
  });

  it('does not rectify when KV matches D1', async () => {
    await createConnection(env.DB, makeConnection({
      id: 'conn-ok',
      secret_url_segment_1: 'secret-ok',
      encrypted_tokens: 'encrypted-data',
    }));

    // Write a matching KV entry
    const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('conn-ok').first<any>();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(USER_ID).first<any>();
    const entry = buildProxyCacheEntry(
      { ...conn, auth_type: conn.auth_type as 'oauth' | 'api_key', key_storage_mode: conn.key_storage_mode as 'managed' | 'zero_knowledge', status: conn.status, service: conn.service } as Connection,
      user as User,
      null,
      null,
      'encrypted-data',
    );
    await writeProxyCache(env, 'secret-ok', entry);

    const result = await checkKvD1Consistency(env);

    expect(result.checked).toBe(1);
    expect(result.rectified).toBe(0);
    expect(result.unrectifiable).toBe(0);

    // No anomalies
    const anomalies = await env.DB.prepare('SELECT * FROM anomaly_reports').all();
    expect(anomalies.results.length).toBe(0);
  });
});
