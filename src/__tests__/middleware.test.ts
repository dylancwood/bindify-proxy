import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureUser, MaxUsersReachedError } from '../auth/middleware';
import { getUserById } from '../db/queries';

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

describe('ensureUser', () => {
  it('creates a new user on first call with free_trial plan and trial_ends_at set', async () => {
    const { user, isNew } = await ensureUser(env.DB, 'clerk_user_1');

    expect(isNew).toBe(true);
    expect(user).not.toBeNull();
    expect(user.id).toBe('clerk_user_1');
    expect(user.plan).toBe('free_trial');
    expect(user.trial_ends_at).not.toBeNull();

    // trial_ends_at should be roughly 24 hours from now
    const trialEnd = new Date(user.trial_ends_at!).getTime();
    const expectedEnd = Date.now() + 24 * 60 * 60 * 1000;
    // Allow 5 seconds of tolerance
    expect(Math.abs(trialEnd - expectedEnd)).toBeLessThan(5000);
  });

  it('returns existing user on subsequent calls with same created_at', async () => {
    const { user: firstCall } = await ensureUser(env.DB, 'clerk_user_2');
    const { user: secondCall, isNew } = await ensureUser(env.DB, 'clerk_user_2');

    expect(isNew).toBe(false);
    expect(firstCall.id).toBe(secondCall.id);
    expect(firstCall.created_at).toBe(secondCall.created_at);
    expect(firstCall.plan).toBe(secondCall.plan);
    expect(firstCall.trial_ends_at).toBe(secondCall.trial_ends_at);

    // Verify only one user exists in the database
    const user = await getUserById(env.DB, 'clerk_user_2');
    expect(user).not.toBeNull();
    expect(user!.created_at).toBe(firstCall.created_at);
  });

  it('throws MaxUsersReachedError when user count >= MAX_USERS and user is new', async () => {
    await ensureUser(env.DB, 'existing_1');
    await ensureUser(env.DB, 'existing_2');
    await ensureUser(env.DB, 'existing_3');

    await expect(ensureUser(env.DB, 'new_user', { maxUsers: 3 })).rejects.toThrow(MaxUsersReachedError);
  });

  it('returns existing user even when at max capacity', async () => {
    await ensureUser(env.DB, 'existing_1');
    await ensureUser(env.DB, 'existing_2');
    await ensureUser(env.DB, 'existing_3');

    const { user } = await ensureUser(env.DB, 'existing_1', { maxUsers: 3 });
    expect(user.id).toBe('existing_1');
  });

  it('skips cap check when maxUsers is undefined', async () => {
    await ensureUser(env.DB, 'user_1');
    await ensureUser(env.DB, 'user_2');
    await ensureUser(env.DB, 'user_3');

    const { user } = await ensureUser(env.DB, 'user_4');
    expect(user.id).toBe('user_4');
  });
});
