import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { makeFixedCredentials } from './test-helpers';

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
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

describe('Streamable HTTP routing', () => {
  const creds = makeFixedCredentials(0x03, 0x04);

  it('POST /mcp/todoist/{credentials} routes to streamable HTTP handler', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    // Health check short-circuit should return 200
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.result.status).toBe('ok');
  });

  it('GET /mcp/todoist/{credentials} routes to streamable HTTP handler', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}`, {
      headers: { 'Accept': 'text/event-stream' },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Connection not found');
  });

  it('POST /mcp/todoist/{credentials} with non-health-check returns 404 for bad secrets', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Connection not found');
  });

  it('PUT /mcp/todoist/{credentials} returns 405', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}`, {
      method: 'PUT',
    });
    expect(response.status).toBe(405);
    const body = await response.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain('Method not allowed');
  });
});

describe('SSE routes return error for streamable-http services', () => {
  const creds = makeFixedCredentials(0x05, 0x06);

  it('GET /mcp/todoist/{credentials}/sse returns 400 with helpful message', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}/sse`);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });

  it('POST /mcp/todoist/{credentials}/messages returns 400 with helpful message for non-health-check', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });

  it('POST /mcp/todoist/{credentials}/messages still handles health check', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${creds.credentials}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 42 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.result.status).toBe('ok');
  });
});
