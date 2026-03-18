import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanupStaleSuspendedConnections } from '../cleanup';
import { createUser, getConnectionsByUserId, getExistingConnectionIds } from '../db/queries';

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
    key_storage_mode TEXT NOT NULL DEFAULT 'managed',
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

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscriptions').run();
  await env.DB.prepare('DELETE FROM connection_events').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('cleanupStaleSuspendedConnections', () => {
  const userId = 'user_cleanup';
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it('deletes connections suspended more than 60 days ago and their KV tokens', async () => {
    await createUser(env.DB, userId, trialEnd);

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Create connection suspended 90 days ago (stale)
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_stale', userId, 'linear', 'seg1_stale', 'suspended', 'managed', ninetyDaysAgo).run();

    // Create connection suspended 30 days ago (not stale)
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_recent', userId, 'todoist', 'seg1_recent', 'suspended', 'managed', thirtyDaysAgo).run();

    // Write proxy cache entries for both
    await env.KV.put('proxy:seg1_stale', 'cache_data');
    await env.KV.put('proxy:seg1_recent', 'cache_data');

    const count = await cleanupStaleSuspendedConnections(env.DB, env.KV, 60);

    expect(count).toBe(1);

    // Stale connection should be deleted from DB
    const connections = await getConnectionsByUserId(env.DB, userId);
    expect(connections).toHaveLength(1);
    expect(connections[0].id).toBe('conn_recent');

    // Stale proxy cache should be tombstoned
    const tombstoneStale = await env.KV.get('proxy:seg1_stale');
    expect(JSON.parse(tombstoneStale!)).toEqual(expect.objectContaining({ schemaVersion: 0, deleted: true }));

    // Recent proxy cache should still exist
    expect(await env.KV.get('proxy:seg1_recent')).toBe('cache_data');
  });

  it('does nothing when no stale connections exist', async () => {
    await createUser(env.DB, userId, trialEnd);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_active', userId, 'linear', 'seg1_active', 'active', 'managed').run();

    const count = await cleanupStaleSuspendedConnections(env.DB, env.KV, 60);

    expect(count).toBe(0);

    const connections = await getConnectionsByUserId(env.DB, userId);
    expect(connections).toHaveLength(1);
    expect(connections[0].id).toBe('conn_active');
  });
});

describe('getExistingConnectionIds', () => {
  const userId = 'user_batch';
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it('returns only IDs that exist', async () => {
    await createUser(env.DB, userId, trialEnd);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_exist_1', userId, 'linear', 'seg1_exist_1', 'active', 'managed').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_exist_2', userId, 'todoist', 'seg1_exist_2', 'active', 'managed').run();

    const result = await getExistingConnectionIds(env.DB, [
      'conn_exist_1', 'conn_exist_2', 'conn_fake_1', 'conn_fake_2',
    ]);

    expect(result).toEqual(new Set(['conn_exist_1', 'conn_exist_2']));
  });

  it('returns empty set when no IDs match', async () => {
    const result = await getExistingConnectionIds(env.DB, ['conn_nope_1', 'conn_nope_2']);
    expect(result).toEqual(new Set());
  });

  it('returns empty set for empty input', async () => {
    const result = await getExistingConnectionIds(env.DB, []);
    expect(result).toEqual(new Set());
  });

  it('handles batches larger than 50', async () => {
    await createUser(env.DB, userId, trialEnd);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_big_1', userId, 'linear', 'seg1_big_1', 'active', 'managed').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_big_2', userId, 'todoist', 'seg1_big_2', 'active', 'managed').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_big_3', userId, 'notion', 'seg1_big_3', 'active', 'managed').run();

    const fakeIds = Array.from({ length: 57 }, (_, i) => `conn_fake_big_${i}`);
    const allIds = ['conn_big_1', 'conn_big_2', 'conn_big_3', ...fakeIds];

    const result = await getExistingConnectionIds(env.DB, allIds);

    expect(result).toEqual(new Set(['conn_big_1', 'conn_big_2', 'conn_big_3']));
  });
});
