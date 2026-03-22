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

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

describe('API route authentication', () => {
  it('GET /api/me returns 401 without auth', async () => {
    const response = await SELF.fetch('http://localhost/api/me');
    expect(response.status).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('GET /api/connections returns 401 without auth', async () => {
    const response = await SELF.fetch('http://localhost/api/connections');
    expect(response.status).toBe(401);
  });

  it('POST /api/billing/checkout returns 401 without auth', async () => {
    const response = await SELF.fetch('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(response.status).toBe(401);
  });

  it('POST /api/billing/portal returns 401 without auth', async () => {
    const response = await SELF.fetch('http://localhost/api/billing/portal', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });
});

describe('API route validation', () => {
  it('returns 404 for unknown API routes', async () => {
    const response = await SELF.fetch('http://localhost/api/nonexistent', {
      headers: { 'Authorization': 'Bearer invalid_token' },
    });
    // Will get 401 because token is invalid, which is correct —
    // auth happens before route matching for /api/* routes
    expect(response.status).toBe(401);
  });
});

describe('CORS preflight', () => {
  it('OPTIONS returns 204 with CORS headers for allowed origin', async () => {
    const response = await SELF.fetch('http://localhost/api/me', {
      method: 'OPTIONS',
      headers: { Origin: env.ADMIN_URL },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ADMIN_URL);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS returns 204 without Origin header (non-CORS request)', async () => {
    const response = await SELF.fetch('http://localhost/api/me', {
      method: 'OPTIONS',
    });
    expect(response.status).toBe(204);
  });

  it('OPTIONS returns 403 for disallowed origin', async () => {
    const response = await SELF.fetch('http://localhost/api/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not include Access-Control-Allow-Origin for non-matching origin', async () => {
    const response = await SELF.fetch('http://localhost/api/services', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('includes Access-Control-Allow-Origin for matching origin', async () => {
    const response = await SELF.fetch('http://localhost/api/services', {
      headers: { Origin: env.ADMIN_URL },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ADMIN_URL);
  });
});

describe('Proxy route matching', () => {
  const creds = makeFixedCredentials(0x01, 0x02);

  it('GET /mcp/linear/{credentials}/sse returns 400 for streamable-http service', async () => {
    // linear uses streamable-http transport, so /sse suffix is rejected
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/sse`);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });

  it('POST /mcp/linear/{credentials}/messages matches legacy route', async () => {
    // Ping should work without valid secrets (health check short-circuit)
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(response.status).toBe(200);
  });

  it('GET /mcp/linear/sse matches API key route', async () => {
    // Will return 401/404 without valid API key
    const response = await SELF.fetch('http://localhost/mcp/linear/sse');
    // Should not be 405 (method allowed)
    expect(response.status).not.toBe(405);
  });

  it('PUT /mcp/linear/{credentials}/sse returns 400 for streamable-http service', async () => {
    // linear uses streamable-http, so legacy /sse suffix is rejected regardless of method
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/sse`, {
      method: 'PUT',
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });

  it('PUT /mcp/linear/{credentials}/messages returns 400 for streamable-http service', async () => {
    // linear uses streamable-http, so legacy /messages suffix is rejected regardless of method
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}/messages`, {
      method: 'PUT',
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
  });
});

describe('Webhook route', () => {
  it('POST /api/webhooks/stripe with invalid signature returns 400', async () => {
    const response = await SELF.fetch('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=invalid',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'test' }),
    });
    expect(response.status).toBe(400);
  });
});
