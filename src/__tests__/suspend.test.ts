import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { suspendExcessConnections, reactivateSuspendedConnections } from '../billing/suspend';
import { createUser, createConnection, getConnectionsByUserId } from '../db/queries';

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

describe('suspendExcessConnections', () => {
  const userId = 'user_suspend';
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it('suspends newest connections when over limit', async () => {
    await createUser(env.DB, userId, trialEnd);

    // Create 3 connections with staggered created_at timestamps
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_old', userId, 'linear', 'seg1_old', 'active', 'managed', '2025-01-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_mid', userId, 'todoist', 'seg1_mid', 'active', 'managed', '2025-06-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_new', userId, 'notion', 'seg1_new', 'active', 'managed', '2025-12-01T00:00:00Z').run();

    await suspendExcessConnections(env, userId, 1);

    const connections = await getConnectionsByUserId(env.DB, userId);
    const byId = Object.fromEntries(connections.map(c => [c.id, c]));

    // Oldest stays active
    expect(byId['conn_old'].status).toBe('active');
    // Newer ones get suspended
    expect(byId['conn_mid'].status).toBe('suspended');
    expect(byId['conn_new'].status).toBe('suspended');
  });

  it('sets suspended_at timestamp when suspending connections', async () => {
    await createUser(env.DB, userId, trialEnd);

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_keep', userId, 'linear', 'seg1_keep', 'active', 'managed', '2025-01-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_suspend', userId, 'todoist', 'seg1_suspend', 'active', 'managed', '2025-06-01T00:00:00Z').run();

    const beforeSuspend = new Date().toISOString();
    await suspendExcessConnections(env, userId, 1);
    const afterSuspend = new Date().toISOString();

    const connections = await getConnectionsByUserId(env.DB, userId);
    const kept = connections.find(c => c.id === 'conn_keep')!;
    const suspended = connections.find(c => c.id === 'conn_suspend')!;

    // Kept connection should not have suspended_at
    expect(kept.suspended_at).toBeNull();

    // Suspended connection should have suspended_at set
    expect(suspended.suspended_at).not.toBeNull();
    expect(suspended.suspended_at! >= beforeSuspend).toBe(true);
    expect(suspended.suspended_at! <= afterSuspend).toBe(true);
  });

  it('clears suspended_at when connections are reactivated', async () => {
    await createUser(env.DB, userId, trialEnd);

    // Create an active connection and a suspended connection with suspended_at set
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_active', userId, 'linear', 'seg1_active', 'active', 'managed', '2025-01-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_was_suspended', userId, 'todoist', 'seg1_was_suspended', 'suspended', 'managed', '2025-06-01T00:00:00Z', '2025-12-01T00:00:00Z').run();

    // Verify suspended_at is set before reactivation
    let connections = await getConnectionsByUserId(env.DB, userId);
    let suspended = connections.find(c => c.id === 'conn_was_suspended')!;
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspended_at).toBe('2025-12-01T00:00:00Z');

    // Reactivate with maxAllowed=2 (room for both connections)
    await reactivateSuspendedConnections(env, userId, 2);

    connections = await getConnectionsByUserId(env.DB, userId);
    const reactivated = connections.find(c => c.id === 'conn_was_suspended')!;

    // Status should be active and suspended_at should be cleared
    expect(reactivated.status).toBe('active');
    expect(reactivated.suspended_at).toBeNull();
  });

  it('reactivates oldest suspended connections first (FIFO)', async () => {
    await createUser(env.DB, userId, trialEnd);

    // 1 active connection
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_active', userId, 'linear', 'seg1_active', 'active', 'managed', '2025-01-01T00:00:00Z').run();

    // 2 suspended connections with different created_at
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_susp_old', userId, 'todoist', 'seg1_susp_old', 'suspended', 'managed', '2025-03-01T00:00:00Z', '2025-12-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_susp_new', userId, 'notion', 'seg1_susp_new', 'suspended', 'managed', '2025-06-01T00:00:00Z', '2025-12-01T00:00:00Z').run();

    // Only room for 1 more (maxAllowed=2, 1 active already)
    await reactivateSuspendedConnections(env, userId, 2);

    const connections = await getConnectionsByUserId(env.DB, userId);
    const byId = Object.fromEntries(connections.map(c => [c.id, c]));

    // Oldest suspended should be reactivated
    expect(byId['conn_susp_old'].status).toBe('active');
    expect(byId['conn_susp_old'].suspended_at).toBeNull();

    // Newest suspended should remain suspended
    expect(byId['conn_susp_new'].status).toBe('suspended');
    expect(byId['conn_susp_new'].suspended_at).toBe('2025-12-01T00:00:00Z');
  });

  it('does not reactivate when no capacity available', async () => {
    await createUser(env.DB, userId, trialEnd);

    // 1 active connection, maxAllowed=1
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_active', userId, 'linear', 'seg1_active', 'active', 'managed', '2025-01-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at, suspended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('conn_still_susp', userId, 'todoist', 'seg1_still_susp', 'suspended', 'managed', '2025-06-01T00:00:00Z', '2025-12-01T00:00:00Z').run();

    await reactivateSuspendedConnections(env, userId, 1);

    const connections = await getConnectionsByUserId(env.DB, userId);
    const suspended = connections.find(c => c.id === 'conn_still_susp')!;
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspended_at).toBe('2025-12-01T00:00:00Z');
  });

  it('does nothing when under limit', async () => {
    await createUser(env.DB, userId, trialEnd);

    await createConnection(env.DB, {
      id: 'conn_only',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'seg1_only',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    await suspendExcessConnections(env, userId, 3);

    const connections = await getConnectionsByUserId(env.DB, userId);
    expect(connections).toHaveLength(1);
    expect(connections[0].status).toBe('active');
  });

  describe('lazy suspension on expired trial', () => {
    it('suspends all connections when free trial has expired via handleGetMe', async () => {
      const userId = 'user_expired_trial';
      const expiredTrialEnd = new Date(Date.now() - 60000).toISOString(); // expired 1 min ago
      await createUser(env.DB, userId, expiredTrialEnd);

      await env.DB.prepare(
        `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('conn_trial_exp', userId, 'linear', 'seg1_trial_exp', 'active', 'managed', '2025-01-01T00:00:00Z').run();

      // Call suspendExcessConnections with maxAllowed=0 (simulating what handleGetMe will do)
      await suspendExcessConnections(env, userId, 0);

      const connections = await getConnectionsByUserId(env.DB, userId);
      expect(connections[0].status).toBe('suspended');
      expect(connections[0].suspended_at).not.toBeNull();
    });

    it('is idempotent — does not error when connections already suspended', async () => {
      const userId = 'user_already_suspended';
      const expiredTrialEnd = new Date(Date.now() - 60000).toISOString();
      await createUser(env.DB, userId, expiredTrialEnd);

      await env.DB.prepare(
        `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, created_at, suspended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('conn_already_susp', userId, 'linear', 'seg1_already_susp', 'suspended', 'managed', '2025-01-01T00:00:00Z', '2025-12-01T00:00:00Z').run();

      // Should not throw
      await suspendExcessConnections(env, userId, 0);

      const connections = await getConnectionsByUserId(env.DB, userId);
      expect(connections[0].status).toBe('suspended');
    });
  });
});
