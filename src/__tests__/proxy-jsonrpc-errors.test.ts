import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { makeFixedCredentials } from './test-helpers';
import { PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';

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

function makeJsonRpcRequest(url: string, method: string, id: number | string = 1) {
  return SELF.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, id }),
  });
}

async function expectJsonRpcError(
  response: Response,
  httpStatus: number,
  jsonRpcCode: number,
  messageSubstring: string,
  expectedId: number | string | null = 1
) {
  expect(response.status).toBe(httpStatus);
  const body = await response.json() as any;
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBe(expectedId);
  expect(body.error.code).toBe(jsonRpcCode);
  expect(body.error.message).toContain(messageSubstring);
}

const notFoundCreds = makeFixedCredentials(0x30, 0x31);
const suspendedCreds = makeFixedCredentials(0x32, 0x33);
const errorCreds = makeFixedCredentials(0x34, 0x35);

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }

  // Insert test user with an active free trial (far future)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, plan, trial_ends_at) VALUES ('jsonrpc-test-user', 'free_trial', '2099-12-31T23:59:59Z')`
  ).run();

  // Insert a suspended connection
  await env.DB.prepare(
    `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, suspended_at)
     VALUES ('conn-suspended', 'jsonrpc-test-user', 'todoist', ?, 'suspended', 'managed', '2026-01-01T00:00:00Z')`
  ).bind(suspendedCreds.secret1).run();

  // Insert an error connection
  await env.DB.prepare(
    `INSERT OR IGNORE INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode)
     VALUES ('conn-error', 'jsonrpc-test-user', 'todoist', ?, 'error', 'managed')`
  ).bind(errorCreds.secret1).run();

  // Populate KV proxy cache entries so the proxy handler can find them
  const suspendedCacheEntry = {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: 'conn-suspended',
    userId: 'jsonrpc-test-user',
    service: 'todoist',
    status: 'suspended',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'managed',
    keyVersion: 1,
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens: '',
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
  await env.KV.put(`proxy:${suspendedCreds.secret1}`, JSON.stringify(suspendedCacheEntry));

  const errorCacheEntry = {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: 'conn-error',
    userId: 'jsonrpc-test-user',
    service: 'todoist',
    status: 'error',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'managed',
    keyVersion: 1,
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens: '',
    user: { plan: 'free_trial', trialEndsAt: '2099-12-31T23:59:59Z', accessUntil: null },
    subscriptionStatus: null,
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };
  await env.KV.put(`proxy:${errorCreds.secret1}`, JSON.stringify(errorCacheEntry));
});

describe('Streamable HTTP POST - JSON-RPC error responses', () => {
  it('returns -32001 when connection not found', async () => {
    const response = await makeJsonRpcRequest(
      `http://localhost/mcp/todoist/${notFoundCreds.credentials}`,
      'tools/call'
    );
    await expectJsonRpcError(response, 404, -32001, 'Connection not found');
  });

  it('returns -32002 when connection is suspended', async () => {
    const response = await makeJsonRpcRequest(
      `http://localhost/mcp/todoist/${suspendedCreds.credentials}`,
      'tools/call'
    );
    await expectJsonRpcError(response, 402, -32002, 'Connection suspended');
  });

  it('returns -32003 when connection has error status', async () => {
    const response = await makeJsonRpcRequest(
      `http://localhost/mcp/todoist/${errorCreds.credentials}`,
      'tools/call'
    );
    await expectJsonRpcError(response, 502, -32003, 'Connection error');
  });

  it('preserves the JSON-RPC request id', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${notFoundCreds.credentials}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 'custom-id-42' }),
    });
    await expectJsonRpcError(response, 404, -32001, 'Connection not found', 'custom-id-42');
  });

  it('does not leak service name or secret in error message', async () => {
    const response = await makeJsonRpcRequest(
      `http://localhost/mcp/todoist/${notFoundCreds.credentials}`,
      'tools/call'
    );
    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.error.message).not.toContain('todoist');
    expect(body.error.message).not.toContain('/mcp/');
  });
});

describe('Streamable HTTP GET - JSON-RPC error responses', () => {
  it('returns -32001 with null id for connection not found', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${notFoundCreds.credentials}`, {
      headers: { 'Accept': 'text/event-stream' },
    });
    await expectJsonRpcError(response, 404, -32001, 'Connection not found', null);
  });
});

describe('SSE routes for streamable-http services', () => {
  // All services in the registry use streamable-http transport, so the router
  // returns a 400 plain-text error before reaching handleProxySSE. We verify
  // that SSE paths do NOT return JSON-RPC errors for streamable-http services.
  it('GET /mcp/todoist/{credentials}/sse returns plain text 400, not JSON-RPC', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/todoist/${notFoundCreds.credentials}/sse`);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Streamable HTTP');
    // Should NOT be JSON-RPC
    expect(text).not.toContain('"jsonrpc"');
  });
});
