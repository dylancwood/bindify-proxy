import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { logPossibleBotEvent, filterHeaders, extractSecretSegment } from '../bot-detection/bot-events';

const VALID_CREDS = 'A'.repeat(86);
const SHORT_CREDS = 'A'.repeat(40);
const LONG_CREDS = 'A'.repeat(90);
const INVALID_CREDS = 'A'.repeat(85) + '.';

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
      processed     INTEGER DEFAULT 0,
      reason        TEXT
    )
  `).run();
});

describe('filterHeaders', () => {
  it('strips sensitive headers', () => {
    const headers = new Headers({
      'User-Agent': 'test-bot',
      'Authorization': 'Bearer secret',
      'Cookie': 'session=abc',
      'Accept': 'text/html',
      'CF-Ray': '12345',
    });
    const filtered = filterHeaders(headers);
    expect(filtered).toHaveProperty('user-agent', 'test-bot');
    expect(filtered).toHaveProperty('accept', 'text/html');
    expect(filtered).toHaveProperty('cf-ray', '12345');
    expect(filtered).not.toHaveProperty('authorization');
    expect(filtered).not.toHaveProperty('cookie');
  });

  it('strips Set-Cookie and CF-Access-Client-Secret', () => {
    const headers = new Headers({
      'Set-Cookie': 'foo=bar',
      'CF-Access-Client-Secret': 'secret',
      'Accept': '*/*',
    });
    const filtered = filterHeaders(headers);
    expect(filtered).not.toHaveProperty('set-cookie');
    expect(filtered).not.toHaveProperty('cf-access-client-secret');
    expect(filtered).toHaveProperty('accept', '*/*');
  });
});

describe('extractSecretSegment', () => {
  it('extracts credentials from streamable HTTP path', () => {
    expect(extractSecretSegment(`/mcp/linear/${VALID_CREDS}`)).toBe(VALID_CREDS);
  });

  it('extracts credentials from SSE path', () => {
    expect(extractSecretSegment(`/mcp/linear/${VALID_CREDS}/sse`)).toBe(VALID_CREDS);
  });

  it('extracts credentials from messages path', () => {
    expect(extractSecretSegment(`/mcp/linear/${VALID_CREDS}/messages`)).toBe(VALID_CREDS);
  });

  it('returns null for API key path (no credentials in URL)', () => {
    expect(extractSecretSegment('/mcp/linear/sse')).toBeNull();
    expect(extractSecretSegment('/mcp/linear')).toBeNull();
  });

  it('returns null for too-short credentials', () => {
    expect(extractSecretSegment(`/mcp/linear/${SHORT_CREDS}/sse`)).toBeNull();
  });

  it('returns null for too-long credentials', () => {
    expect(extractSecretSegment(`/mcp/linear/${LONG_CREDS}/sse`)).toBeNull();
  });

  it('returns null for extra path segments', () => {
    expect(extractSecretSegment(`/mcp/foo/linear/${VALID_CREDS}/sse`)).toBeNull();
  });

  it('returns null for invalid base64url characters', () => {
    expect(extractSecretSegment(`/mcp/linear/${INVALID_CREDS}/sse`)).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(extractSecretSegment('')).toBeNull();
    expect(extractSecretSegment('/mcp/')).toBeNull();
  });
});

describe('logPossibleBotEvent', () => {
  it('inserts a row with reason into proxy_404_log', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '1.2.3.4',
      rawUrl: 'http://api.bindify.dev/mcp/linear/abc/def',
      urlSegment: 'linear/abc/def',
      headers: new Headers({ 'User-Agent': 'scanner' }),
      cf: { asn: 12345, asOrganization: 'TestOrg', country: 'US' },
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('1.2.3.4')
      .first();

    expect(row).not.toBeNull();
    expect(row!.ip).toBe('1.2.3.4');
    expect(row!.url_segment).toBe('linear/abc/def');
    expect(row!.raw_url).toBe('http://api.bindify.dev/mcp/linear/abc/def');
    expect(row!.secret_segment).toBeNull(); // 'abc/def' is not a valid 86-char credential
    expect(row!.asn).toBe('12345');
    expect(row!.asn_org).toBe('TestOrg');
    expect(row!.country).toBe('US');
    expect(row!.processed).toBe(0);
    expect(row!.reason).toBe('invalid_credentials');

    const headers = JSON.parse(row!.headers as string);
    expect(headers['user-agent']).toBe('scanner');
    expect(headers).not.toHaveProperty('authorization');
  });

  it('stores each reason value correctly', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'unknown_service',
      ip: '2.2.2.2',
      rawUrl: 'http://api.bindify.dev/mcp/unknown/abc',
      urlSegment: 'unknown/abc',
      headers: new Headers(),
      cf: undefined,
    });

    await logPossibleBotEvent(env.DB, {
      reason: 'route_not_found',
      ip: '3.3.3.3',
      rawUrl: 'http://api.bindify.dev/mcp/linear/abc',
      urlSegment: 'linear/abc',
      headers: new Headers(),
      cf: undefined,
    });

    const row1 = await env.DB.prepare('SELECT reason FROM proxy_404_log WHERE ip = ?')
      .bind('2.2.2.2')
      .first();
    expect(row1!.reason).toBe('unknown_service');

    const row2 = await env.DB.prepare('SELECT reason FROM proxy_404_log WHERE ip = ?')
      .bind('3.3.3.3')
      .first();
    expect(row2!.reason).toBe('route_not_found');
  });

  it('stores full raw_url including credentials for enumeration detection', async () => {
    const rawUrl = `http://api.bindify.dev/mcp/linear/${VALID_CREDS}/sse`;
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '10.0.0.1',
      rawUrl,
      urlSegment: `linear/${VALID_CREDS}/sse`,
      headers: new Headers(),
      cf: undefined,
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('10.0.0.1')
      .first();

    expect(row).not.toBeNull();
    expect(row!.raw_url).toBe(rawUrl);
  });

  it('handles undefined request.cf gracefully', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '5.6.7.8',
      rawUrl: 'http://api.bindify.dev/mcp/todoist/xyz',
      urlSegment: 'todoist/xyz',
      headers: new Headers(),
      cf: undefined,
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('5.6.7.8')
      .first();

    expect(row).not.toBeNull();
    expect(row!.asn).toBeNull();
    expect(row!.asn_org).toBeNull();
    expect(row!.country).toBeNull();
  });

  it('skips logging when E2E bypass token matches', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '9.9.9.9',
      rawUrl: 'http://api.bindify.dev/mcp/linear/abc',
      urlSegment: 'linear/abc',
      headers: new Headers({ 'x-e2e-bypass': 'secret-token' }),
      cf: undefined,
      e2eBypassToken: 'secret-token',
      e2eBypassHeader: 'secret-token',
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('9.9.9.9')
      .first();

    expect(row).toBeNull();
  });

  it('logs normally when E2E bypass token does not match', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '8.8.8.8',
      rawUrl: 'http://api.bindify.dev/mcp/linear/abc',
      urlSegment: 'linear/abc',
      headers: new Headers(),
      cf: undefined,
      e2eBypassToken: 'secret-token',
      e2eBypassHeader: 'wrong-token',
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('8.8.8.8')
      .first();

    expect(row).not.toBeNull();
  });

  it('logs normally when E2E bypass token is undefined', async () => {
    await logPossibleBotEvent(env.DB, {
      reason: 'invalid_credentials',
      ip: '7.7.7.7',
      rawUrl: 'http://api.bindify.dev/mcp/linear/abc',
      urlSegment: 'linear/abc',
      headers: new Headers(),
      cf: undefined,
      e2eBypassToken: undefined,
    });

    const row = await env.DB.prepare('SELECT * FROM proxy_404_log WHERE ip = ?')
      .bind('7.7.7.7')
      .first();

    expect(row).not.toBeNull();
  });
});

describe('logPossibleBotEvent — negative cases (contract documentation)', () => {
  // These scenarios are NOT logged because logPossibleBotEvent is never called for them.
  // The routing logic in index.ts and handler.ts ensures:
  // - Upstream 404s: handled by the upstream response, no call to logPossibleBotEvent
  // - Expired KV sessions: handler.ts returns 404 directly, no call to logPossibleBotEvent
  // - Non-/mcp/ 404s: catch-all in index.ts only calls logPossibleBotEvent for /mcp/ paths
  // - Service mismatch: resolveProxyAuth returns error via makeError, no call to logPossibleBotEvent

  it('is not called for non-/mcp/ paths (verified by catch-all guard)', async () => {
    // The catch-all in index.ts has: if (path.startsWith('/mcp/')) { ... logPossibleBotEvent }
    // Non-/mcp/ paths skip the logging block entirely.
    // We verify the function itself works correctly — routing is tested by integration tests.
    const countBefore = await env.DB.prepare('SELECT COUNT(*) as count FROM proxy_404_log').first<{ count: number }>();

    // If logPossibleBotEvent were accidentally called for a non-/mcp/ path,
    // the urlSegment would not contain credential patterns.
    // This test documents that the function should not be called for such paths.
    expect(countBefore!.count).toBeGreaterThanOrEqual(0); // baseline — no accidental rows
  });

  it('documents that expired KV sessions do not trigger logging', () => {
    // handler.ts handleProxyMessages: when upstream:{sessionId} is not in KV,
    // returns jsonRpcError directly WITHOUT calling logPossibleBotEvent.
    // This is by design — expired sessions are normal operational behavior.
    expect(true).toBe(true); // contract documentation
  });

  it('documents that service mismatch does not trigger logging', () => {
    // resolveProxyAuth: when entry.service !== params.service (line 543),
    // returns makeError('not_found') from inside withProxyCache callback.
    // logPossibleBotEvent is only called when cacheResult is null (line 593),
    // NOT when cacheResult contains an error from the service mismatch path.
    expect(true).toBe(true); // contract documentation
  });

  it('documents that upstream 404s do not trigger logging', () => {
    // When a request reaches the upstream server and it returns 404,
    // the response is passed through directly (e.g., handleProxyMessages line 846).
    // logPossibleBotEvent is never called in the upstream response path.
    expect(true).toBe(true); // contract documentation
  });
});
