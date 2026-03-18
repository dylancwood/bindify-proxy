import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleClaimCallback } from '../api/connections';
import { createUser } from '../db/queries';

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

const USER_ID = 'claim-test-user';
const TRIAL_END = '2099-12-31T23:59:59Z';

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM connection_events').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();
  await createUser(env.DB, USER_ID, TRIAL_END);
});

describe('handleClaimCallback', () => {
  const claimData = {
    userId: USER_ID,
    connected: 'linear',
    secret_url: 'https://api.bindify.dev/mcp/linear/test-credentials',
    api_key: 'bnd_test_test-credentials',
    key_storage_mode: 'zero_knowledge',
  };

  it('returns secrets for a valid claim token', async () => {
    const token = 'valid-claim-token';
    await env.KV.put(`callback_claim:${token}`, JSON.stringify(claimData), { expirationTtl: 300 });

    const response = await handleClaimCallback(USER_ID, token, env as any);
    expect(response.status).toBe(200);

    const body = await response.json() as any;
    expect(body.connected).toBe('linear');
    expect(body.secret_url).toBe(claimData.secret_url);
    expect(body.api_key).toBe(claimData.api_key);
    expect(body.key_storage_mode).toBe('zero_knowledge');
  });

  it('deletes the claim token after successful claim (one-time use)', async () => {
    const token = 'one-time-token';
    await env.KV.put(`callback_claim:${token}`, JSON.stringify(claimData), { expirationTtl: 300 });

    // First claim succeeds
    const response1 = await handleClaimCallback(USER_ID, token, env as any);
    expect(response1.status).toBe(200);

    // Second claim fails (token consumed)
    const response2 = await handleClaimCallback(USER_ID, token, env as any);
    expect(response2.status).toBe(404);
  });

  it('returns 404 for an invalid/expired token', async () => {
    const response = await handleClaimCallback(USER_ID, 'nonexistent-token', env as any);
    expect(response.status).toBe(404);

    const body = await response.json() as any;
    expect(body.error).toBe('not_found');
  });

  it('returns 403 when userId does not match', async () => {
    const token = 'wrong-user-token';
    await env.KV.put(`callback_claim:${token}`, JSON.stringify(claimData), { expirationTtl: 300 });

    await createUser(env.DB, 'other-user', TRIAL_END);
    const response = await handleClaimCallback('other-user', token, env as any);
    expect(response.status).toBe(403);

    const body = await response.json() as any;
    expect(body.error).toBe('forbidden');

    // Token should NOT be consumed on auth failure
    const stillExists = await env.KV.get(`callback_claim:${token}`);
    expect(stillExists).toBeTruthy();
  });
});
