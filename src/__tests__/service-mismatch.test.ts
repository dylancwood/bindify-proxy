import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { makeFixedCredentials } from './test-helpers';
import { encryptTokenData } from '../crypto';
import { PROXY_CACHE_SCHEMA_VERSION } from '../proxy/kv-cache';
import type { ProxyCacheEntry } from '../proxy/kv-cache';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    plan TEXT NOT NULL DEFAULT 'free_trial',
    trial_ends_at TEXT,
    access_until TEXT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
`;

const creds = makeFixedCredentials(0x70, 0x71);

async function seedLinearConnection() {
  const tokens = JSON.stringify({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const encrypted = await encryptTokenData(tokens, creds.secret2);

  const entry: ProxyCacheEntry = {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: 'conn-mismatch',
    userId: 'user-mismatch',
    service: 'linear',
    status: 'active',
    authType: 'oauth',
    authMode: null,
    application: null,
    keyStorageMode: 'zero_knowledge',
    keyFingerprint: '',
    dcrRegistration: null,
    needsReauthAt: null,
    encryptedTokens: encrypted,
    user: {
      plan: 'active',
      trialEndsAt: null,
      accessUntil: null,
    },
    subscriptionStatus: 'active',
    subscriptionPastDueSince: null,
    cachedAt: new Date().toISOString(),
  };

  await env.KV.put(`proxy:${creds.secret1}`, JSON.stringify(entry));
}

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  await seedLinearConnection();
});

describe('Service mismatch validation (BIN-162)', () => {
  it('Streamable HTTP POST: returns 404 when URL service does not match connection', async () => {
    // Connection is for "linear" but we request via "github"
    const response = await SELF.fetch(`http://localhost/mcp/github/${creds.credentials}`, {
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
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Connection not found');
  });

  it('Streamable HTTP GET: returns 404 when URL service does not match connection', async () => {
    const response = await SELF.fetch(`http://localhost/mcp/github/${creds.credentials}`, {
      headers: { 'Accept': 'text/event-stream' },
    });
    expect(response.status).toBe(404);
    const body = await response.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Connection not found');
  });

  it('Correct service passes mismatch check', async () => {
    // Same credentials with the correct "linear" service — should get past
    // the mismatch check (will fail at upstream since none is running)
    const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 3, params: {} }),
    });
    // Should NOT be 404 from mismatch — 502 from upstream failure proves the check passed
    expect(response.status).not.toBe(404);
  });
});
