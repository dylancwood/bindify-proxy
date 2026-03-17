import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
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

describe('E2E smoke tests', () => {
  it('GET / returns 200 (landing page)', async () => {
    const response = await SELF.fetch('http://localhost/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Bindify');
  });

  it('GET /api/me without auth returns 401', async () => {
    const response = await SELF.fetch('http://localhost/api/me');
    expect(response.status).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('GET /unknown returns 404', async () => {
    const response = await SELF.fetch('http://localhost/unknown');
    expect(response.status).toBe(404);
  });

  it('POST /mcp/linear/{credentials}/messages with ping returns health check response', async () => {
    const creds = makeFixedCredentials(0x10, 0x20);
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 99 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { jsonrpc: string; result: { status: string }; id: number };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.status).toBe('ok');
    expect(body.id).toBe(99);
  });

  it('GET /mcp/linear/{credentials}/sse returns 400 for streamable-http service', async () => {
    // linear uses streamable-http transport, so /sse suffix is rejected
    const creds = makeFixedCredentials(0x11, 0x22);
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/sse`);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });
});
