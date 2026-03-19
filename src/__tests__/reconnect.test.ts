import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAuthorize } from '../api/connections';
import { createUser, createConnection } from '../db/queries';
import { checkCanConnect } from '../auth/entitlements';

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

describe('reconnect flow', () => {
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const callbackUrl = 'https://api.bindify.dev/api/connections/callback';
  const testEnv = { ...env, LINEAR_CLIENT_ID: 'test-client-id' };

  it('handleAuthorize stores replaceConnectionId in PKCE state', async () => {
    const userId = 'user-reconnect-1';
    await createUser(env.DB, userId, futureDate);

    // Create an existing connection to replace
    await createConnection(env.DB, {
      id: 'conn-old-1',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'secret-old-1',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    const response = await handleAuthorize(
      userId,
      'linear',
      testEnv as any,
      callbackUrl,
      'managed',
      'conn-old-1'
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    const authUrl = new URL(body.url);
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // Read the PKCE state from KV and verify replaceConnectionId was stored
    const raw = await env.KV.get(`oauth:${state}`);
    expect(raw).toBeTruthy();
    const pkceState = JSON.parse(raw!);
    expect(pkceState.replaceConnectionId).toBe('conn-old-1');
    expect(pkceState.userId).toBe(userId);
    expect(pkceState.serviceId).toBe('linear');
  });

  it('handleAuthorize rejects replaceConnectionId belonging to another user', async () => {
    const userA = 'user-a';
    const userB = 'user-b';
    await createUser(env.DB, userA, futureDate);
    await createUser(env.DB, userB, futureDate);

    // Create a connection belonging to user B
    await createConnection(env.DB, {
      id: 'conn-user-b',
      user_id: userB,
      service: 'linear',
      secret_url_segment_1: 'secret-user-b',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    // User A tries to authorize with user B's connection as replaceConnectionId
    const response = await handleAuthorize(
      userA,
      'linear',
      testEnv as any,
      callbackUrl,
      'managed',
      'conn-user-b'
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('not found');
  });

  it('checkCanConnect excludes replaced connection from quota', async () => {
    const userId = 'user-quota';
    await createUser(env.DB, userId, futureDate);

    // Free trial allows 2 connections — create two to hit the limit
    await createConnection(env.DB, {
      id: 'conn-existing',
      user_id: userId,
      service: 'linear',
      secret_url_segment_1: 'secret-existing',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn-existing-2',
      user_id: userId,
      service: 'todoist',
      secret_url_segment_1: 'secret-existing-2',
      status: 'active',
      key_storage_mode: 'managed',
      auth_type: 'oauth',
      dcr_registration: null,
      needs_reauth_at: null,
    });

    // Without exclude: should be blocked (at limit)
    const blocked = await checkCanConnect(env.DB, userId);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('Connection limit reached');

    // With exclude of the existing connection: should be allowed
    const allowed = await checkCanConnect(env.DB, userId, 'conn-existing');
    expect(allowed.allowed).toBe(true);
  });

  it('handleCallback does NOT delete anything when replaceConnectionId is absent', async () => {
    const userId = 'user-normal';
    await createUser(env.DB, userId, futureDate);

    // Normal authorize flow without replaceConnectionId
    const response = await handleAuthorize(
      userId,
      'linear',
      testEnv as any,
      callbackUrl,
      'managed'
      // no replaceConnectionId
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    const authUrl = new URL(body.url);
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // Read PKCE state and verify replaceConnectionId is NOT present
    const raw = await env.KV.get(`oauth:${state}`);
    expect(raw).toBeTruthy();
    const pkceState = JSON.parse(raw!);
    expect(pkceState.replaceConnectionId).toBeUndefined();
    expect(pkceState.userId).toBe(userId);
    expect(pkceState.serviceId).toBe('linear');
  });
});
