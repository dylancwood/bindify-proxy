import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkCanConnect, checkAccessActive } from '../auth/entitlements';
import { createUser, createConnection, upsertSubscription } from '../db/queries';

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

beforeAll(async () => {
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

describe('checkCanConnect', () => {
  it('allows connection during active free trial', async () => {
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_trial', trialEnd);

    const result = await checkCanConnect(env.DB, 'user_trial');
    expect(result.allowed).toBe(true);
    expect(result.maxConnections).toBe(2);
    expect(result.activeConnections).toBe(0);
  });

  it('blocks when trial expired', async () => {
    const trialEnd = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_expired', trialEnd);

    const result = await checkCanConnect(env.DB, 'user_expired');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('trial has expired');
  });

  it('allows connecting when at limit but excluding a connection being replaced', async () => {
    const userId = 'user-replace';
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    await createUser(env.DB, userId, futureDate);

    // Free trial allows 2 connections — fill both slots
    await createConnection(env.DB, {
      id: 'conn-keep',
      user_id: userId,
      service: 'todoist',
      secret_url_segment_1: 'secret-keep',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn-to-replace',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'secret-replace',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    // Without exclude: should be blocked
    const blocked = await checkCanConnect(env.DB, userId);
    expect(blocked.allowed).toBe(false);

    // With exclude: should be allowed
    const allowed = await checkCanConnect(env.DB, userId, 'conn-to-replace');
    expect(allowed.allowed).toBe(true);
  });

  it('blocks when at plan limit', async () => {
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_limit', trialEnd);

    // Free trial allows 2 connections; create two active connections
    await createConnection(env.DB, {
      id: 'conn_limit_1',
      user_id: 'user_limit',
      service: 'linear',
      secret_url_segment_1: 'sl1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_limit_2',
      user_id: 'user_limit',
      service: 'todoist',
      secret_url_segment_1: 'sl2',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const result = await checkCanConnect(env.DB, 'user_limit');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Connection limit reached');
    expect(result.maxConnections).toBe(2);
    expect(result.activeConnections).toBe(2);
  });
});

describe('checkAccessActive', () => {
  it('allows proxy access for active subscription', async () => {
    const trialEnd = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_active_sub', trialEnd);

    // Set plan to bundle and clear trial
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?")
      .bind('user_active_sub')
      .run();

    await upsertSubscription(env.DB, {
      id: 'sub_active_1',
      user_id: 'user_active_sub',

      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await checkAccessActive(env.DB, 'user_active_sub');
    expect(result.active).toBe(true);
  });

  it('blocks proxy access when canceled and past period end', async () => {
    const trialEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_canceled', trialEnd);

    // Set plan to canceled with past access_until
    const pastAccess = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE users SET plan = 'canceled', trial_ends_at = NULL, access_until = ? WHERE id = ?")
      .bind(pastAccess, 'user_canceled')
      .run();

    const result = await checkAccessActive(env.DB, 'user_canceled');
    expect(result.active).toBe(false);
    expect(result.reason).toContain('canceled');
  });

  it('blocks access immediately when free trial expires (no grace period)', async () => {
    // Trial expired 1 minute ago
    const trialEnd = new Date(Date.now() - 60 * 1000).toISOString();
    await createUser(env.DB, 'user_trial_expired', trialEnd);

    const result = await checkAccessActive(env.DB, 'user_trial_expired');
    expect(result.active).toBe(false);
    expect(result.reason).toContain('trial has expired');
  });

  it('allows access when payment failed less than 3 days ago', async () => {
    const trialEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_grace_ok', trialEnd);
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?")
      .bind('user_grace_ok')
      .run();

    // past_due subscription with past_due_since 1 day ago
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await upsertSubscription(env.DB, {
      id: 'sub_grace_ok',
      user_id: 'user_grace_ok',

      quantity: 1,
      status: 'past_due',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await env.DB.prepare("UPDATE subscriptions SET past_due_since = ? WHERE id = ?")
      .bind(oneDayAgo, 'sub_grace_ok')
      .run();

    const result = await checkAccessActive(env.DB, 'user_grace_ok');
    expect(result.active).toBe(true);
  });

  it('blocks access when payment failed more than 3 days ago', async () => {
    const trialEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_grace_expired', trialEnd);
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?")
      .bind('user_grace_expired')
      .run();

    // past_due subscription with past_due_since 4 days ago
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await upsertSubscription(env.DB, {
      id: 'sub_grace_expired',
      user_id: 'user_grace_expired',

      quantity: 1,
      status: 'past_due',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await env.DB.prepare("UPDATE subscriptions SET past_due_since = ? WHERE id = ?")
      .bind(fourDaysAgo, 'sub_grace_expired')
      .run();

    const result = await checkAccessActive(env.DB, 'user_grace_expired');
    expect(result.active).toBe(false);
    expect(result.reason).toContain('past due');
  });

  it('restores access after payment succeeds following failure', async () => {
    const trialEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_restored', trialEnd);
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?")
      .bind('user_restored')
      .run();

    // Subscription was past_due but is now active with past_due_since cleared
    await upsertSubscription(env.DB, {
      id: 'sub_restored',
      user_id: 'user_restored',

      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await checkAccessActive(env.DB, 'user_restored');
    expect(result.active).toBe(true);
  });
});
