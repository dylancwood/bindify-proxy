import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { writeConnectionEvent, getConnectionEvents } from '../db/connection-events';
import { createUser, createConnection } from '../db/queries';

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

const USER_ID = 'evt-test-user';
const CONN_ID = 'evt-test-conn';
const TRIAL_END = '2099-12-31T23:59:59Z';

beforeAll(async () => {
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM connection_events').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();

  await createUser(env.DB, USER_ID, TRIAL_END);
  await createConnection(env.DB, {
    id: CONN_ID,
    user_id: USER_ID,
    service: 'github',
    secret_url_segment_1: 'evt-secret1',
    status: 'active',
    key_storage_mode: 'zero_knowledge',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    dcr_registration: null,
    needs_reauth_at: null,
  });
});

describe('writeConnectionEvent', () => {
  it('writes an event and reads it back', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'success',
      detail: 'Token refreshed via proxy',
    });

    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('token_refresh');
    expect(events[0].category).toBe('success');
    expect(events[0].detail).toBe('Token refreshed via proxy');
    expect(events[0].id).toBeTruthy();
    expect(events[0].createdAt).toBeTruthy();
  });

  it('writes events with upstream_status', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: 'Refresh returned 401: invalid_grant',
      upstreamStatus: 401,
    });

    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
    expect(events[0].upstreamStatus).toBe(401);
  });

  it('respects the limit parameter in getConnectionEvents', async () => {
    for (let i = 0; i < 5; i++) {
      await writeConnectionEvent(env.DB, {
        connectionId: CONN_ID,
        eventType: 'token_refresh',
        category: 'success',
        detail: `Refresh ${i}`,
      });
    }

    const limited = await getConnectionEvents(env.DB, CONN_ID, 3);
    expect(limited).toHaveLength(3);
    // Most recent first
    expect(limited[0].detail).toBe('Refresh 4');
  });

  it('returns events ordered by created_at DESC', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'connection_created',
      category: 'oauth',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'success',
    });

    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events[0].eventType).toBe('token_refresh');
    expect(events[1].eventType).toBe('connection_created');
  });
});

describe('deduplication', () => {
  it('always writes token_refresh/success (no dedup)', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'success',
      detail: 'Refreshed via proxy',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'success',
      detail: 'Refreshed via proxy',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(2);
  });

  it('deduplicates token_refresh failures with same category+detail within 1 hour', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: 'Refresh returned 401',
      upstreamStatus: 401,
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: 'Refresh returned 401',
      upstreamStatus: 401,
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
  });

  it('does NOT deduplicate token_refresh failures with different detail', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: 'Refresh returned 401',
      upstreamStatus: 401,
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: 'Refresh returned 500',
      upstreamStatus: 500,
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(2);
  });

  it('deduplicates auth failures with same category+detail within 1 hour', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'kv_miss',
      detail: 'Session not found',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'kv_miss',
      detail: 'Session not found',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
  });

  it('writes auth/success only when previous auth event was a failure', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'kv_miss',
      detail: 'Session not found',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'success',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(2);
    expect(events[0].category).toBe('success');
  });

  it('skips auth/success when no previous auth failure exists', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'success',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(0);
  });

  it('deduplicates proxy_request/success within 5 minutes', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'success',
      detail: 'github:streamable-http',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'success',
      detail: 'github:streamable-http',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
  });

  it('deduplicates proxy_request/upstream_error by upstream_status within 1 hour', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'upstream_error',
      upstreamStatus: 502,
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'upstream_error',
      upstreamStatus: 502,
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
  });

  it('deduplicates auth failures with null detail', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'unknown',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'auth',
      category: 'unknown',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(1);
  });

  it('always writes reauth/success (no dedup)', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'reauth',
      category: 'success',
      detail: 'Replaced connection old-conn-1',
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'reauth',
      category: 'success',
      detail: 'Replaced connection old-conn-2',
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(2);
  });

  it('does NOT deduplicate proxy_request/upstream_error with different status', async () => {
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'upstream_error',
      upstreamStatus: 502,
    });
    await writeConnectionEvent(env.DB, {
      connectionId: CONN_ID,
      eventType: 'proxy_request',
      category: 'upstream_error',
      upstreamStatus: 503,
    });
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(2);
  });
});

describe('pruning', () => {
  it('prunes events beyond 200 per connection', async () => {
    for (let i = 0; i < 205; i++) {
      await writeConnectionEvent(env.DB, {
        connectionId: CONN_ID,
        eventType: 'token_refresh',
        category: 'success',
        detail: `Refresh ${i}`,
      });
    }
    const events = await getConnectionEvents(env.DB, CONN_ID);
    expect(events).toHaveLength(200);
    expect(events[0].detail).toBe('Refresh 204');
    expect(events[199].detail).toBe('Refresh 5');
  });
});
