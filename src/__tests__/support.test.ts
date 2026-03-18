import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

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
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

describe('Support endpoints', () => {
  describe('POST /api/support/nonce', () => {
    it('returns a nonce string', async () => {
      const response = await SELF.fetch('http://localhost/api/support/nonce', {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { nonce: string };
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe('string');
      expect(body.nonce.length).toBeGreaterThan(0);
    });

    it('returns different nonces on each call', async () => {
      const response1 = await SELF.fetch('http://localhost/api/support/nonce', {
        method: 'POST',
      });
      const response2 = await SELF.fetch('http://localhost/api/support/nonce', {
        method: 'POST',
      });
      const body1 = await response1.json() as { nonce: string };
      const body2 = await response2.json() as { nonce: string };
      expect(body1.nonce).not.toBe(body2.nonce);
    });
  });

  describe('POST /api/support/ticket', () => {
    it('returns 503 when Zoho is not configured and all fields valid', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      const formData = new FormData();
      formData.append('nonce', nonce);
      formData.append('email', 'test@example.com');
      formData.append('topic', 'Test topic');
      formData.append('description', 'Test description');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('service_unavailable');
    });

    it('returns 400 for missing nonce', async () => {
      const formData = new FormData();
      formData.append('email', 'test@example.com');
      formData.append('topic', 'Test topic');
      formData.append('description', 'Test description');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toContain('nonce');
    });

    it('returns 400 for missing email', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      const formData = new FormData();
      formData.append('nonce', nonce);
      formData.append('topic', 'Test topic');
      formData.append('description', 'Test description');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toContain('email');
    });

    it('returns 400 for invalid email', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      const formData = new FormData();
      formData.append('nonce', nonce);
      formData.append('email', 'not-an-email');
      formData.append('topic', 'Test topic');
      formData.append('description', 'Test description');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toContain('email');
    });

    it('returns 400 for missing topic', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      const formData = new FormData();
      formData.append('nonce', nonce);
      formData.append('email', 'test@example.com');
      formData.append('description', 'Test description');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toContain('topic');
    });

    it('consumes nonce even when field validation fails', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      // First request: valid nonce but missing email → 400
      const formData1 = new FormData();
      formData1.append('nonce', nonce);
      formData1.append('topic', 'Test topic');
      formData1.append('description', 'Test description');
      const response1 = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData1,
      });
      expect(response1.status).toBe(400);

      // Second request: same nonce with all fields valid → 403 (nonce already consumed)
      const formData2 = new FormData();
      formData2.append('nonce', nonce);
      formData2.append('email', 'test@example.com');
      formData2.append('topic', 'Test topic');
      formData2.append('description', 'Test description');
      const response2 = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData2,
      });
      expect(response2.status).toBe(403);
      const body = await response2.json() as { error: string };
      expect(body.error).toBe('invalid_nonce');
    });

    it('returns 400 for missing description', async () => {
      const nonceRes = await SELF.fetch('http://localhost/api/support/nonce', { method: 'POST' });
      const { nonce } = await nonceRes.json() as { nonce: string };

      const formData = new FormData();
      formData.append('nonce', nonce);
      formData.append('email', 'test@example.com');
      formData.append('topic', 'Test topic');

      const response = await SELF.fetch('http://localhost/api/support/ticket', {
        method: 'POST',
        body: formData,
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toContain('escription');
    });
  });
});
