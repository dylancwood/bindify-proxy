import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { makeFixedCredentials } from './test-helpers';

beforeAll(async () => {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS proxy_404_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ip            TEXT    NOT NULL,
      url_segment   TEXT    NOT NULL,
      raw_url       TEXT,
      secret_segment TEXT,
      headers       TEXT,
      timestamp     INTEGER NOT NULL,
      asn           TEXT,
      asn_org       TEXT,
      country       TEXT,
      processed     INTEGER DEFAULT 0
    )
  `).run();
  // The proxy handler queries the connections table — create it so we get
  // a proper 404 (connection not found) instead of a 500 (table missing).
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
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
    )
  `).run();
});

describe('Bot detection integration', () => {
  const creds = makeFixedCredentials(0x50, 0x51);

  describe('blocklist enforcement', () => {
    it('returns 429 for blocked IPs', async () => {
      await env.KV.put('blocked:1.2.3.4', 'scanner pattern');

      const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      });

      expect(response.status).toBe(429);
      const body = await response.json() as any;
      expect(body.error).toBe('rate_limited');
      expect(response.headers.get('Retry-After')).toBe('600');
    });

    it('allows non-blocked IPs through', async () => {
      const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        headers: { 'CF-Connecting-IP': '9.9.9.9' },
      });

      // Should not be 429 — will be 404 or similar since connection doesn't exist
      expect(response.status).not.toBe(429);
    });
  });

  describe('allowlist bypass', () => {
    it('skips blocklist check for allowlisted IPs', async () => {
      await env.KV.put('blocked:10.0.0.1', 'scanner pattern');

      // 10.0.0.1 is in IP_ALLOWLIST (set in vitest.config.ts)
      const response = await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        headers: { 'CF-Connecting-IP': '10.0.0.1' },
      });

      // Should NOT be 429 — allowlist bypasses blocklist
      expect(response.status).not.toBe(429);
    });
  });

  describe('404 logging', () => {
    it('does NOT log 404 events for non-/mcp/* routes', async () => {
      await SELF.fetch('http://localhost/api/nonexistent', {
        headers: { 'CF-Connecting-IP': '8.8.8.8' },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
        .bind('8.8.8.8')
        .first();

      expect(row).toBeNull();
    });

    it('stores raw_url, url_segment, and secret_segment for credential-bearing 404s', async () => {
      const creds = makeFixedCredentials(0x60, 0x61);

      await SELF.fetch(`http://localhost/mcp/linear/${creds.credentials}`, {
        headers: { 'CF-Connecting-IP': '7.7.7.7' },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const row = await env.DB.prepare('SELECT raw_url, url_segment, secret_segment FROM proxy_404_log WHERE ip = ?')
        .bind('7.7.7.7')
        .first<{ raw_url: string; url_segment: string; secret_segment: string }>();

      expect(row).not.toBeNull();
      expect(row!.raw_url).toBe(`http://localhost/mcp/linear/${creds.credentials}`);
      expect(row!.url_segment).toBe(`linear/${creds.credentials}`);
      expect(row!.secret_segment).toBe(creds.credentials);
    });

    it('stores null secret_segment for malformed paths (fallthrough 404)', async () => {
      await SELF.fetch('http://localhost/mcp/foo/bar/baz', {
        headers: { 'CF-Connecting-IP': '6.6.6.6' },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const row = await env.DB.prepare('SELECT raw_url, url_segment, secret_segment FROM proxy_404_log WHERE ip = ?')
        .bind('6.6.6.6')
        .first<{ raw_url: string; url_segment: string; secret_segment: string | null }>();

      expect(row).not.toBeNull();
      expect(row!.raw_url).toBe('http://localhost/mcp/foo/bar/baz');
      expect(row!.url_segment).toBe('foo/bar/baz');
      expect(row!.secret_segment).toBeNull();
    });

    it('produces correct uniqueSegments for mixed credential-bearing and non-credential paths', async () => {
      const creds1 = makeFixedCredentials(0x70, 0x71);
      const creds2 = makeFixedCredentials(0x72, 0x73);

      await SELF.fetch(`http://localhost/mcp/linear/${creds1.credentials}`, {
        headers: { 'CF-Connecting-IP': '5.5.5.5' },
      });
      await SELF.fetch(`http://localhost/mcp/linear/${creds2.credentials}`, {
        headers: { 'CF-Connecting-IP': '5.5.5.5' },
      });
      await SELF.fetch('http://localhost/mcp/garbage/path', {
        headers: { 'CF-Connecting-IP': '5.5.5.5' },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const rows = await env.DB.prepare('SELECT secret_segment, url_segment FROM proxy_404_log WHERE ip = ?')
        .bind('5.5.5.5')
        .all<{ secret_segment: string | null; url_segment: string }>();

      expect(rows.results.length).toBe(3);
      const withSecret = rows.results.filter(r => r.secret_segment !== null);
      const withoutSecret = rows.results.filter(r => r.secret_segment === null);
      expect(withSecret.length).toBe(2);
      expect(withoutSecret.length).toBe(1);
    });
  });
});
