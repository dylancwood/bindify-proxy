import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleDeleteAccount } from '../api/account-api';
import { createUser, getUserById, getConnectionsByUserId, getSubscriptionsByUserId } from '../db/queries';

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

const originalFetch = globalThis.fetch;

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDeleteAccount', () => {
  const userId = 'user_delete_test';
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it('successfully deletes all user data', async () => {
    // Set up user with stripe_customer_id
    await createUser(env.DB, userId, trialEnd);
    await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .bind('cus_test123', userId).run();

    // Create connections with KV tokens
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_1', userId, 'linear', 'seg1_1', 'active', 'managed').run();

    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_2', userId, 'todoist', 'seg1_2', 'active', 'managed').run();

    await env.KV.put('proxy:seg1_1', 'cache_data_1');
    await env.KV.put('proxy:seg1_2', 'cache_data_2');

    // Create subscriptions
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, quantity, status, current_period_end)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('sub_1', userId, 1, 'active', '2026-04-01T00:00:00Z').run();

    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, quantity, status, current_period_end)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('sub_2', userId, 1, 'canceled', '2026-03-15T00:00:00Z').run();

    // Mock fetch for Stripe and Clerk calls
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.stripe.com') || url.includes('api.clerk.com')) {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await handleDeleteAccount(
      env.DB, env.KV, userId, 'cus_test123', 'sk_test_stripe', 'sk_test_clerk'
    );
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // KV proxy cache tombstoned
    const tombstone1 = await env.KV.get('proxy:seg1_1');
    expect(JSON.parse(tombstone1!)).toEqual(expect.objectContaining({ schemaVersion: 0, deleted: true }));
    const tombstone2 = await env.KV.get('proxy:seg1_2');
    expect(JSON.parse(tombstone2!)).toEqual(expect.objectContaining({ schemaVersion: 0, deleted: true }));

    // DB records deleted
    expect(await getUserById(env.DB, userId)).toBeNull();
    expect(await getConnectionsByUserId(env.DB, userId)).toHaveLength(0);
    expect(await getSubscriptionsByUserId(env.DB, userId)).toHaveLength(0);

    // Stripe calls: only active sub canceled (not canceled sub), + customer delete
    const stripeCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('api.stripe.com');
    });
    // sub_1 (active) should be canceled, sub_2 (canceled) should not, + customer delete
    expect(stripeCalls).toHaveLength(2);

    // Clerk call made
    const clerkCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('api.clerk.com');
    });
    expect(clerkCalls).toHaveLength(1);
    const clerkUrl = typeof clerkCalls[0][0] === 'string' ? clerkCalls[0][0] : '';
    expect(clerkUrl).toContain(`/v1/users/${userId}`);
  });

  it('handles user with no connections or subscriptions', async () => {
    await createUser(env.DB, userId, trialEnd);

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.stripe.com') || url.includes('api.clerk.com')) {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await handleDeleteAccount(
      env.DB, env.KV, userId, null, 'sk_test_stripe', 'sk_test_clerk'
    );
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // User deleted from DB
    expect(await getUserById(env.DB, userId)).toBeNull();

    // Clerk call still made
    const clerkCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('api.clerk.com');
    });
    expect(clerkCalls).toHaveLength(1);
  });

  it('handles user with no Stripe customer', async () => {
    await createUser(env.DB, userId, trialEnd);

    // Add a connection to verify KV/DB cleanup still happens
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind('conn_no_stripe', userId, 'linear', 'seg1_ns', 'active', 'managed').run();
    await env.KV.put('proxy:seg1_ns', 'cache_data');

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.stripe.com') || url.includes('api.clerk.com')) {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await handleDeleteAccount(
      env.DB, env.KV, userId, null, 'sk_test_stripe', 'sk_test_clerk'
    );
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // No Stripe calls made
    const stripeCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('api.stripe.com');
    });
    expect(stripeCalls).toHaveLength(0);

    // KV proxy cache tombstoned
    const tombstoneNs = await env.KV.get('proxy:seg1_ns');
    expect(JSON.parse(tombstoneNs!)).toEqual(expect.objectContaining({ schemaVersion: 0, deleted: true }));

    // DB cleaned up
    expect(await getUserById(env.DB, userId)).toBeNull();
    expect(await getConnectionsByUserId(env.DB, userId)).toHaveLength(0);

    // Clerk call still made
    const clerkCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes('api.clerk.com');
    });
    expect(clerkCalls).toHaveLength(1);
  });
});
