import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { acquireLock, releaseLock, keepaliveDCRRegistrations, refreshManagedConnection, keepaliveManagedConnection, refreshStaleConnections } from '../scheduler';
import { createConnection } from '../db/queries';
import { deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey } from '../crypto';

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

describe('Cron lock', () => {
  beforeEach(async () => {
    await env.KV.delete('cron:refresh:lock');
  });

  it('acquires lock when none exists', async () => {
    const acquired = await acquireLock(env.KV);
    expect(acquired).toBe(true);
  });

  it('fails to acquire when lock is held', async () => {
    await acquireLock(env.KV);
    const second = await acquireLock(env.KV);
    expect(second).toBe(false);
  });

  it('releases lock', async () => {
    await acquireLock(env.KV);
    await releaseLock(env.KV);
    const acquired = await acquireLock(env.KV);
    expect(acquired).toBe(true);
  });
});

describe('keepaliveDCRRegistrations', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connections').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare("INSERT INTO users (id, plan) VALUES ('user1', 'active')").run();
    vi.restoreAllMocks();
  });

  it('flags connections when DCR registration is dead (404)', async () => {
    const regJson = JSON.stringify({
      client_id: 'dead-client',
      registration_client_uri: 'https://mcp.notion.com/register/dead-client',
    });
    const encKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn1');
    const encReg = await encryptTokenDataWithKey(regJson, encKey);
    await createConnection(env.DB, {
      id: 'conn1', user_id: 'user1', service: 'notion', secret_url_segment_1: 'secret1',
      status: 'active', key_storage_mode: 'managed',
      auth_type: 'oauth', auth_mode: null, application: null,
      dcr_registration: encReg, encrypted_tokens: null, needs_reauth_at: null,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await keepaliveDCRRegistrations(env);

    const conn = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn1').first<{ needs_reauth_at: string | null }>();
    expect(conn!.needs_reauth_at).not.toBeNull();
  });

  it('does not flag connections when registration is alive', async () => {
    const regJson = JSON.stringify({
      client_id: 'alive-client',
      registration_client_uri: 'https://mcp.notion.com/register/alive-client',
    });
    const encKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn2');
    const encReg = await encryptTokenDataWithKey(regJson, encKey);
    await createConnection(env.DB, {
      id: 'conn2', user_id: 'user1', service: 'notion', secret_url_segment_1: 'secret2',
      status: 'active', key_storage_mode: 'managed',
      auth_type: 'oauth', auth_mode: null, application: null,
      dcr_registration: encReg, encrypted_tokens: null, needs_reauth_at: null,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await keepaliveDCRRegistrations(env);

    const conn = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn2').first<{ needs_reauth_at: string | null }>();
    expect(conn!.needs_reauth_at).toBeNull();
  });

  it('only flags connections with dead client_id when multiple exist', async () => {
    const deadRegJson = JSON.stringify({ client_id: 'dead-client', registration_client_uri: 'https://mcp.notion.com/register/dead-client' });
    const aliveRegJson = JSON.stringify({ client_id: 'alive-client', registration_client_uri: 'https://mcp.notion.com/register/alive-client' });

    const deadKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn-dead');
    const encDeadReg = await encryptTokenDataWithKey(deadRegJson, deadKey);
    const aliveKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, 'conn-alive');
    const encAliveReg = await encryptTokenDataWithKey(aliveRegJson, aliveKey);

    await createConnection(env.DB, {
      id: 'conn-dead', user_id: 'user1', service: 'notion', secret_url_segment_1: 'secret-dead',
      status: 'active', key_storage_mode: 'managed',
      auth_type: 'oauth', auth_mode: null, application: null,
      dcr_registration: encDeadReg, encrypted_tokens: null, needs_reauth_at: null,
    });
    await createConnection(env.DB, {
      id: 'conn-alive', user_id: 'user1', service: 'notion', secret_url_segment_1: 'secret-alive',
      status: 'active', key_storage_mode: 'managed',
      auth_type: 'oauth', auth_mode: null, application: null,
      dcr_registration: encAliveReg, encrypted_tokens: null, needs_reauth_at: null,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (url) => {
      const urlStr = url instanceof Request ? url.url : url.toString();
      if (urlStr.includes('dead-client')) return new Response('Not found', { status: 404 });
      return new Response('ok', { status: 200 });
    });

    await keepaliveDCRRegistrations(env);

    const dead = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-dead').first<{ needs_reauth_at: string | null }>();
    const alive = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-alive').first<{ needs_reauth_at: string | null }>();
    expect(dead!.needs_reauth_at).not.toBeNull();
    expect(alive!.needs_reauth_at).toBeNull();
  });

  it('skips connections with null dcr_registration', async () => {
    await createConnection(env.DB, {
      id: 'conn-no-dcr', user_id: 'user1', service: 'notion', secret_url_segment_1: 'secret-no-dcr',
      status: 'active', key_storage_mode: 'managed',
      auth_type: 'oauth', auth_mode: null, application: null,
      dcr_registration: null, encrypted_tokens: null, needs_reauth_at: null,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await keepaliveDCRRegistrations(env);
    expect(fetchSpy).not.toHaveBeenCalled();

    const conn = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-no-dcr').first<{ needs_reauth_at: string | null }>();
    expect(conn!.needs_reauth_at).toBeNull();
  });
});

describe('refreshManagedConnection failure handling', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connections').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare("INSERT INTO users (id, plan) VALUES ('user1', 'active')").run();
    vi.restoreAllMocks();
  });

  async function setupManagedConnection(id: string, dcrRegistration: string | null) {
    const encryptionKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, id);
    const tokens = JSON.stringify({
      access_token: 'access_old',
      refresh_token: 'refresh_old',
      expires_at: Math.floor(Date.now() / 1000) - 100, // expired
    });
    const encrypted = await encryptTokenDataWithKey(tokens, encryptionKey);

    // Encrypt DCR registration with managed key (mirrors handleCallback behavior)
    let encryptedDcrRegistration: string | null = null;
    if (dcrRegistration) {
      const dcrKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, id);
      encryptedDcrRegistration = await encryptTokenDataWithKey(dcrRegistration, dcrKey);
    }

    const conn = {
      id,
      user_id: 'user1',
      service: 'notion' as const,
      secret_url_segment_1: `s1-${id}`,
      status: 'active' as const,
      key_storage_mode: 'managed' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: encryptedDcrRegistration,
      encrypted_tokens: encrypted,
      needs_reauth_at: null,
    };
    await createConnection(env.DB, conn);
    return { ...conn, key_version: 1, created_at: '', last_used_at: null, last_refreshed_at: null, suspended_at: null };
  }

  it('sets needs_reauth_at on invalid_grant', async () => {
    const reg = JSON.stringify({ client_id: 'dcr-client-1' });
    const conn = await setupManagedConnection('conn-ig', reg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );
    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);
    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-ig').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).not.toBeNull();
  });

  it('sets needs_reauth_at on invalid_client', async () => {
    const reg = JSON.stringify({ client_id: 'dcr-client-2' });
    const conn = await setupManagedConnection('conn-ic', reg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })
    );
    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);
    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-ic').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).not.toBeNull();
  });

  it('does NOT set needs_reauth_at on transient 500 error', async () => {
    const reg = JSON.stringify({ client_id: 'dcr-client-3' });
    const conn = await setupManagedConnection('conn-500', reg);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );
    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);
    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-500').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).toBeNull();
  });

  it('uses dcr_registration.client_id for refresh request', async () => {
    const reg = JSON.stringify({ client_id: 'pinned-dcr-client-id' });
    const conn = await setupManagedConnection('conn-pinned', reg);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'new_access', refresh_token: 'new_refresh', expires_in: 3600,
      }), { status: 200 })
    );
    await refreshManagedConnection(conn, env);
    const [, init] = fetchSpy.mock.calls[0];
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('client_id')).toBe('pinned-dcr-client-id');
  });
});

describe('keepaliveManagedConnection', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connection_events').run();
    await env.DB.prepare('DELETE FROM connections').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare("INSERT INTO users (id, plan) VALUES ('user1', 'active')").run();
    vi.restoreAllMocks();
  });

  async function setupTodoistManagedConnection(id: string, needsReauthAt?: string) {
    const encryptionKey = await deriveManagedEncryptionKey(env.MANAGED_ENCRYPTION_MASTER_KEY, id);
    const tokens = JSON.stringify({
      access_token: 'todoist_access_token',
      refresh_token: '',
      expires_at: Math.floor(Date.now() / 1000) + 315360000, // 10 years
    });
    const encrypted = await encryptTokenDataWithKey(tokens, encryptionKey);

    const conn = {
      id,
      user_id: 'user1',
      service: 'todoist' as const,
      secret_url_segment_1: `s1-${id}`,
      status: 'active' as const,
      key_storage_mode: 'managed' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      encrypted_tokens: encrypted,
      needs_reauth_at: needsReauthAt ?? null,
    };
    await createConnection(env.DB, conn);
    if (needsReauthAt) {
      await env.DB.prepare('UPDATE connections SET needs_reauth_at = ? WHERE id = ?')
        .bind(needsReauthAt, id).run();
    }
    return { ...conn, key_version: 1, created_at: '', last_used_at: null, last_refreshed_at: null, suspended_at: null };
  }

  it('updates last_refreshed_at on successful keep-alive', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-ok');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(new Response('data: {"result":{}}\n\n', {
        status: 200,
        headers: { 'mcp-session-id': 'session-123' },
      }))
      .mockResolvedValueOnce(new Response('data: {"result":{"tools":[{"name":"todoist_create_task"}]}}\n\n', {
        status: 200,
      }));

    const result = await keepaliveManagedConnection(conn, env);
    expect(result).toBe(true);

    const row = await env.DB.prepare('SELECT last_refreshed_at FROM connections WHERE id = ?')
      .bind('conn-ka-ok').first<{ last_refreshed_at: string | null }>();
    expect(row!.last_refreshed_at).not.toBeNull();
  });

  it('clears needs_reauth_at on successful keep-alive', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-clear', '2026-03-11T00:00:00.000Z');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(new Response('data: {"result":{}}\n\n', {
        status: 200,
        headers: { 'mcp-session-id': 'session-456' },
      }))
      .mockResolvedValueOnce(new Response('data: {"result":{"tools":[{"name":"todoist_create_task"}]}}\n\n', {
        status: 200,
      }));

    const result = await keepaliveManagedConnection(conn, env);
    expect(result).toBe(true);

    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-ka-clear').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).toBeNull();
  });

  it('sets needs_reauth_at on 401 auth failure', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-401');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await keepaliveManagedConnection(conn, env);
    expect(result).toBe(false);

    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-ka-401').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).not.toBeNull();
  });

  it('does NOT set needs_reauth_at on 500 transient error', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-500');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    const result = await keepaliveManagedConnection(conn, env);
    expect(result).toBe(false);

    const row = await env.DB.prepare('SELECT needs_reauth_at FROM connections WHERE id = ?')
      .bind('conn-ka-500').first<{ needs_reauth_at: string | null }>();
    expect(row!.needs_reauth_at).toBeNull();
  });

  it('sends correct auth header from service config', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-header');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(new Response('data: {"result":{}}\n\n', {
        status: 200,
        headers: { 'mcp-session-id': 'session-789' },
      }))
      .mockResolvedValueOnce(new Response('data: {"result":{"tools":[]}}\n\n', {
        status: 200,
      }));

    await keepaliveManagedConnection(conn, env);

    // First call is initialize — check Authorization header
    const [, initOpts] = fetchSpy.mock.calls[0];
    const headers = initOpts?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer todoist_access_token');
  });

  it('logs keepalive/success event on success', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-event');

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('data: {"result":{}}\n\n', {
        status: 200,
        headers: { 'mcp-session-id': 'session-evt' },
      }))
      .mockResolvedValueOnce(new Response('data: {"result":{"tools":[{"name":"t1"}]}}\n\n', {
        status: 200,
      }));

    await keepaliveManagedConnection(conn, env);

    const events = await env.DB.prepare(
      'SELECT event_type, category FROM connection_events WHERE connection_id = ?'
    ).bind('conn-ka-event').all<{ event_type: string; category: string }>();
    expect(events.results).toContainEqual({ event_type: 'keepalive', category: 'success' });
  });

  it('logs keepalive/auth_failed event on 401', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-evt-401');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    await keepaliveManagedConnection(conn, env);

    const events = await env.DB.prepare(
      'SELECT event_type, category, upstream_status FROM connection_events WHERE connection_id = ?'
    ).bind('conn-ka-evt-401').all<{ event_type: string; category: string; upstream_status: number | null }>();
    expect(events.results).toContainEqual({ event_type: 'keepalive', category: 'auth_failed', upstream_status: 401 });
  });

  it('logs keepalive/transient_error event on 500', async () => {
    const conn = await setupTodoistManagedConnection('conn-ka-evt-500');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    await keepaliveManagedConnection(conn, env);

    const events = await env.DB.prepare(
      'SELECT event_type, category, upstream_status FROM connection_events WHERE connection_id = ?'
    ).bind('conn-ka-evt-500').all<{ event_type: string; category: string; upstream_status: number | null }>();
    expect(events.results).toContainEqual({ event_type: 'keepalive', category: 'transient_error', upstream_status: 500 });
  });
});

describe('ZK mode safety', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM connection_events').run();
    await env.DB.prepare('DELETE FROM connections').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare("INSERT INTO users (id, plan) VALUES ('user1', 'active')").run();
    vi.restoreAllMocks();
  });

  it('refreshManagedConnection returns false and writes event for ZK connection', async () => {
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, encrypted_tokens)
       VALUES ('conn-zk', 'user1', 'linear', 's1-conn-zk', 'active', 'zero_knowledge', 'oauth', 'fake-encrypted')`
    ).run();

    const conn = {
      id: 'conn-zk',
      user_id: 'user1',
      service: 'linear' as const,
      secret_url_segment_1: 's1-conn-zk',
      status: 'active' as const,
      key_storage_mode: 'zero_knowledge' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      encrypted_tokens: 'fake-encrypted',
      needs_reauth_at: null,
      suspended_at: null,
      last_used_at: null,
      last_refreshed_at: null,
      created_at: '',
    };

    const result = await refreshManagedConnection(conn, env);
    expect(result).toBe(false);

    const events = await env.DB.prepare(
      "SELECT * FROM connection_events WHERE connection_id = 'conn-zk'"
    ).all();
    expect(events.results.length).toBeGreaterThan(0);
    expect((events.results[0] as any).category).toBe('unknown');
  });

  it('keepaliveManagedConnection returns false and writes event for ZK connection', async () => {
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, encrypted_tokens)
       VALUES ('conn-zk-ka', 'user1', 'todoist', 's1-conn-zk-ka', 'active', 'zero_knowledge', 'oauth', 'fake')`
    ).run();

    const conn = {
      id: 'conn-zk-ka',
      user_id: 'user1',
      service: 'todoist' as const,
      secret_url_segment_1: 's1-conn-zk-ka',
      status: 'active' as const,
      key_storage_mode: 'zero_knowledge' as const,
      auth_type: 'oauth' as const,
      auth_mode: null,
      application: null,
      dcr_registration: null,
      encrypted_tokens: 'fake-encrypted',
      needs_reauth_at: null,
      suspended_at: null,
      last_used_at: null,
      last_refreshed_at: null,
      created_at: '',
    };

    const result = await keepaliveManagedConnection(conn, env);
    expect(result).toBe(false);

    const events = await env.DB.prepare(
      "SELECT * FROM connection_events WHERE connection_id = 'conn-zk-ka'"
    ).all();
    expect(events.results.length).toBeGreaterThan(0);
    expect((events.results[0] as any).category).toBe('unknown');
  });

  it('refreshStaleConnections does not refresh ZK connections (end-to-end)', async () => {
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, encrypted_tokens, last_refreshed_at)
       VALUES ('conn-zk-stale', 'user1', 'linear', 's1-conn-zk-stale', 'active', 'zero_knowledge', 'oauth', 'fake-encrypted', ?)`
    ).bind(staleDate).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await refreshStaleConnections(env);

    const zkConn = await env.DB.prepare(
      'SELECT last_refreshed_at FROM connections WHERE id = ?'
    ).bind('conn-zk-stale').first<{ last_refreshed_at: string }>();
    expect(zkConn!.last_refreshed_at).toBe(staleDate);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
