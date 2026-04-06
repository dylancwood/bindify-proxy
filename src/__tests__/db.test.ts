import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getUserById,
  createUser,
  getConnectionsByUserId,
  getConnectionBySecret1,
  createConnection,
  updateConnectionStatus,
  deleteConnection,
  updateConnectionLastUsed,
  getActiveConnectionCount,
  getMaxConnections,
  upsertSubscription,
  getSubscriptionsByUserId,
  getStaleSuspendedConnections,
  deleteUserCascade,
  getStaleConnections,
  updateConnectionLastRefreshed,
  setNeedsReauthAt,
  clearNeedsReauthAt,
  updateConnectionLabel,
} from '../db/queries';

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

// Apply schema before all tests
beforeAll(async () => {
  const statements = SCHEMA
    .split(';')
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

describe('User queries', () => {
  it('creates and retrieves a user', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_1', trialEnd);

    const user = await getUserById(env.DB, 'user_1');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('user_1');
    expect(user!.plan).toBe('free_trial');
    expect(user!.trial_ends_at).toBe(trialEnd);
  });

  it('returns null for non-existent user', async () => {
    const user = await getUserById(env.DB, 'nonexistent');
    expect(user).toBeNull();
  });

  it('does not throw when creating a user with an existing id', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_dup', trialEnd);

    // Second insert with same ID should not throw
    await expect(createUser(env.DB, 'user_dup', trialEnd)).resolves.not.toThrow();

    // Original user should still exist unchanged
    const user = await getUserById(env.DB, 'user_dup');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('user_dup');
  });
});

describe('Connection queries', () => {
  const userId = 'user_conn';
  const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    await createUser(env.DB, userId, trialEnd);
  });

  it('looks up connection by secret1', async () => {
    await createConnection(env.DB, {
      id: 'conn_1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'secret_a',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conn = await getConnectionBySecret1(env.DB, 'secret_a');
    expect(conn).not.toBeNull();
    expect(conn!.id).toBe('conn_1');
  });

  it('returns null for non-existent secret1', async () => {
    const conn = await getConnectionBySecret1(env.DB, 'nonexistent');
    expect(conn).toBeNull();
  });

  it('counts active connections excluding suspended ones', async () => {
    await createConnection(env.DB, {
      id: 'conn_a1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 's1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_a2',
      user_id: userId,
      service: 'todoist',
      secret_url_segment_1: 's3',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_a3',
      user_id: userId,
      service: 'notion',
      secret_url_segment_1: 's5',
      status: 'suspended',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const count = await getActiveConnectionCount(env.DB, userId);
    expect(count).toBe(2);
  });

  it('gets connections by user id', async () => {
    await createConnection(env.DB, {
      id: 'conn_list1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'ls1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conns = await getConnectionsByUserId(env.DB, userId);
    expect(conns).toHaveLength(1);
    expect(conns[0].id).toBe('conn_list1');
  });

  it('updates connection status', async () => {
    await createConnection(env.DB, {
      id: 'conn_upd',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'us1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    await updateConnectionStatus(env.DB, 'conn_upd', 'error');
    const conn = await getConnectionBySecret1(env.DB, 'us1');
    expect(conn!.status).toBe('error');
  });

  it('deletes a connection', async () => {
    await createConnection(env.DB, {
      id: 'conn_del',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'ds1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    await deleteConnection(env.DB, 'conn_del');
    const conn = await getConnectionBySecret1(env.DB, 'ds1');
    expect(conn).toBeNull();
  });

  it('updates last used timestamp', async () => {
    await createConnection(env.DB, {
      id: 'conn_lu',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'lu1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    await updateConnectionLastUsed(env.DB, 'conn_lu');
    const conn = await getConnectionBySecret1(env.DB, 'lu1');
    expect(conn!.last_used_at).not.toBeNull();
  });
});

describe('Subscription and max connections', () => {
  const userId = 'user_sub';

  beforeEach(async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, userId, trialEnd);
  });

  it('returns 2 for free trial user', async () => {
    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(2);
  });

  it('returns quantity for a single active subscription', async () => {
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_1',
      user_id: userId,
      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(1);
  });

  it('returns sum of quantity for active subscription', async () => {
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_2',
      user_id: userId,
      quantity: 5,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(5);
  });

  it('does not count canceled subscriptions', async () => {
    await env.DB.prepare("UPDATE users SET plan = 'canceled', trial_ends_at = NULL WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_4',
      user_id: userId,
      quantity: 1,
      status: 'canceled',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(0);
  });

  it('returns max(2, subscription) when trial is still active and user has subscription', async () => {
    // User subscribed for 1 connection but trial (2 connections) is still active
    await env.DB.prepare("UPDATE users SET plan = 'active' WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_overlap_1',
      user_id: userId,
      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(2); // trial gives 2, subscription gives 1, max = 2
  });

  it('returns subscription quantity when trial is active but subscription is larger', async () => {
    await env.DB.prepare("UPDATE users SET plan = 'active' WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_overlap_3',
      user_id: userId,
      quantity: 5,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(5); // trial gives 2, subscription gives 5, max = 5
  });

  it('returns subscription quantity when trial has expired', async () => {
    const expiredTrial = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = ? WHERE id = ?").bind(expiredTrial, userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_expired_trial',
      user_id: userId,
      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(1); // trial expired, only subscription counts
  });

  it('upserts subscription (update existing)', async () => {
    await env.DB.prepare("UPDATE users SET plan = 'active', trial_ends_at = NULL WHERE id = ?").bind(userId).run();

    await upsertSubscription(env.DB, {
      id: 'sub_upsert',
      user_id: userId,
      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update quantity
    await upsertSubscription(env.DB, {
      id: 'sub_upsert',
      user_id: userId,
      quantity: 3,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const max = await getMaxConnections(env.DB, userId);
    expect(max).toBe(3);
  });
});

describe('getStaleSuspendedConnections', () => {
  const userId = 'user_stale';
  const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    await createUser(env.DB, userId, trialEnd);
  });

  it('returns only connections suspended longer than maxAgeDays', async () => {
    // Create 3 connections
    await createConnection(env.DB, {
      id: 'conn_stale_1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'stale_s1',
      status: 'suspended',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_stale_2',
      user_id: userId,
      service: 'todoist',
      secret_url_segment_1: 'stale_s2',
      status: 'suspended',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_stale_3',
      user_id: userId,
      service: 'notion',
      secret_url_segment_1: 'stale_s3',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    // Set suspended_at via raw SQL: 90 days ago, 30 days ago, null
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare('UPDATE connections SET suspended_at = ? WHERE id = ?')
      .bind(ninetyDaysAgo, 'conn_stale_1')
      .run();
    await env.DB.prepare('UPDATE connections SET suspended_at = ? WHERE id = ?')
      .bind(thirtyDaysAgo, 'conn_stale_2')
      .run();

    // maxAgeDays=60 → cutoff is 60 days ago → only the 90-day one qualifies
    const stale = await getStaleSuspendedConnections(env.DB, 60);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('conn_stale_1');
  });

  it('returns empty array when no stale suspended connections exist', async () => {
    const stale = await getStaleSuspendedConnections(env.DB, 60);
    expect(stale).toHaveLength(0);
  });
});

describe('deleteUserCascade', () => {
  const userId = 'user_cascade';
  const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    await createUser(env.DB, userId, trialEnd);
  });

  it('deletes user and all associated connections and subscriptions', async () => {
    // Create 2 connections
    await createConnection(env.DB, {
      id: 'conn_cas_1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'cas_s1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn_cas_2',
      user_id: userId,
      service: 'todoist',
      secret_url_segment_1: 'cas_s2',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    // Create 1 subscription
    await upsertSubscription(env.DB, {
      id: 'sub_cas_1',
      user_id: userId,
      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await deleteUserCascade(env.DB, userId);

    const user = await getUserById(env.DB, userId);
    expect(user).toBeNull();

    const conns = await getConnectionsByUserId(env.DB, userId);
    expect(conns).toHaveLength(0);

    const subs = await getSubscriptionsByUserId(env.DB, userId);
    expect(subs).toHaveLength(0);
  });

  it('works even if user has no connections or subscriptions', async () => {
    await deleteUserCascade(env.DB, userId);

    const user = await getUserById(env.DB, userId);
    expect(user).toBeNull();
  });
});

describe('auth_mode column', () => {
  const userId = 'user_authmode';
  const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    await createUser(env.DB, userId, trialEnd);
  });

  it('creates a connection with auth_mode and reads it back', async () => {
    await createConnection(env.DB, {
      id: 'conn_am_1',
      user_id: userId,
      service: 'atlassian',
      secret_url_segment_1: 'am_s1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'api_key' as const,
      auth_mode: 'service_account',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conn = await getConnectionBySecret1(env.DB, 'am_s1');
    expect(conn).not.toBeNull();
    expect(conn!.auth_mode).toBe('service_account');
  });

  it('defaults auth_mode to null when not provided', async () => {
    await createConnection(env.DB, {
      id: 'conn_am_2',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'am_s2',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conn = await getConnectionBySecret1(env.DB, 'am_s2');
    expect(conn).not.toBeNull();
    expect(conn!.auth_mode).toBeNull();
  });
});

describe('Managed refresh queries', () => {
  it('creates connection with key_storage_mode', async () => {
    await createUser(env.DB, 'user-managed', new Date(Date.now() + 86400000).toISOString());
    await createConnection(env.DB, {
      id: 'conn-managed-1',
      user_id: 'user-managed',
      service: 'linear',
      secret_url_segment_1: 'secret1-managed',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    const conn = await getConnectionBySecret1(env.DB, 'secret1-managed');
    expect(conn?.key_storage_mode).toBe('managed');
  });

  it('getStaleConnections returns managed connections past refresh interval', async () => {
    await createUser(env.DB, 'user-stale', new Date(Date.now() + 86400000).toISOString());
    await createConnection(env.DB, {
      id: 'conn-stale-1',
      user_id: 'user-stale',
      service: 'linear',
      secret_url_segment_1: 'secret1-stale',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    const stale = await getStaleConnections(env.DB, 'linear', 60);
    expect(stale.some(c => c.id === 'conn-stale-1')).toBe(true);
  });

  it('getStaleConnections excludes zero_knowledge connections', async () => {
    await createUser(env.DB, 'user-zk', new Date(Date.now() + 86400000).toISOString());
    await createConnection(env.DB, {
      id: 'conn-zk-1',
      user_id: 'user-zk',
      service: 'linear',
      secret_url_segment_1: 'secret1-zk',
      status: 'active',
      key_storage_mode: 'zero_knowledge',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    const stale = await getStaleConnections(env.DB, 'linear', 60);
    expect(stale.some(c => c.id === 'conn-zk-1')).toBe(false);
  });

  it('updateConnectionLastRefreshed sets timestamp', async () => {
    await createUser(env.DB, 'user-refresh', new Date(Date.now() + 86400000).toISOString());
    await createConnection(env.DB, {
      id: 'conn-refresh-1',
      user_id: 'user-refresh',
      service: 'linear',
      secret_url_segment_1: 'secret1-refresh',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await updateConnectionLastRefreshed(env.DB, 'conn-refresh-1');
    const conn = await getConnectionBySecret1(env.DB, 'secret1-refresh');
    expect(conn?.last_refreshed_at).toBeTruthy();
  });
});

describe('dcr_registration', () => {
  it('stores dcr_registration on connection creation', async () => {
    await createUser(env.DB, 'user_dcr', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_dcr',
      user_id: 'user_dcr',
      service: 'notion',
      secret_url_segment_1: 'dcr_s1',
      status: 'active',
      key_storage_mode: 'zero_knowledge',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: JSON.stringify({ client_id: 'test_client_id_abc' }),
      needs_reauth_at: null,
    });
    const conn = await getConnectionBySecret1(env.DB, 'dcr_s1');
    expect(conn!.dcr_registration).not.toBeNull();
    const reg = JSON.parse(conn!.dcr_registration!);
    expect(reg.client_id).toBe('test_client_id_abc');
  });

  it('stores null dcr_registration for non-DCR connections', async () => {
    await createUser(env.DB, 'user_nodcr', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_nodcr',
      user_id: 'user_nodcr',
      service: 'linear',
      secret_url_segment_1: 'nodcr_s1',
      status: 'active',
      key_storage_mode: 'zero_knowledge',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    const conn = await getConnectionBySecret1(env.DB, 'nodcr_s1');
    expect(conn!.dcr_registration).toBeNull();
  });
});

describe('needs_reauth_at', () => {
  it('sets needs_reauth_at on a connection', async () => {
    await createUser(env.DB, 'user_reauth', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_reauth',
      user_id: 'user_reauth',
      service: 'linear',
      secret_url_segment_1: 'reauth_s1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await setNeedsReauthAt(env.DB, 'conn_reauth', '2026-03-11T12:00:00Z');
    const conn = await getConnectionBySecret1(env.DB, 'reauth_s1');
    expect(conn!.needs_reauth_at).toBe('2026-03-11T12:00:00Z');
  });

  it('clears needs_reauth_at on a connection', async () => {
    await createUser(env.DB, 'user_clear', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_clear',
      user_id: 'user_clear',
      service: 'linear',
      secret_url_segment_1: 'clear_s1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: '2026-03-11T12:00:00Z',
    });
    await clearNeedsReauthAt(env.DB, 'conn_clear');
    const conn = await getConnectionBySecret1(env.DB, 'clear_s1');
    expect(conn!.needs_reauth_at).toBeNull();
  });
});

describe('Connection label', () => {
  it('updates connection label', async () => {
    await createUser(env.DB, 'user_label', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_label_1',
      user_id: 'user_label',
      service: 'linear',
      secret_url_segment_1: 'label_s1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    await updateConnectionLabel(env.DB, 'conn_label_1', 'My Custom Label');
    const conn = await getConnectionBySecret1(env.DB, 'label_s1');
    expect(conn!.label).toBe('My Custom Label');
  });

  it('creates connection with label', async () => {
    await createUser(env.DB, 'user_label2', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_label_2',
      user_id: 'user_label2',
      service: 'linear',
      secret_url_segment_1: 'label_s2',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      label: 'Linear 1',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conn = await getConnectionBySecret1(env.DB, 'label_s2');
    expect(conn!.label).toBe('Linear 1');
  });

  it('defaults label to null when not provided', async () => {
    await createUser(env.DB, 'user_label3', '2099-01-01');
    await createConnection(env.DB, {
      id: 'conn_label_3',
      user_id: 'user_label3',
      service: 'linear',
      secret_url_segment_1: 'label_s3',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const conn = await getConnectionBySecret1(env.DB, 'label_s3');
    expect(conn!.label).toBeNull();
  });
});
