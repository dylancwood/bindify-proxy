import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { acquireRefreshLock, cleanupExpiredRefreshLocks } from '../db/queries';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS refresh_locks (
    connection_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
`;

beforeAll(async () => {
  await env.DB.prepare(SCHEMA).run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM refresh_locks').run();
  // Clean up any cooldown keys from previous tests
  const listed = await env.KV.list({ prefix: 'refresh_cooldown:' });
  for (const key of listed.keys) {
    await env.KV.delete(key.name);
  }
});

describe('acquireRefreshLock', () => {
  it('acquires lock when no existing lock', async () => {
    const acquired = await acquireRefreshLock(env.DB, 'conn-1', 3);
    expect(acquired).toBe(true);
  });

  it('fails to acquire when lock is held', async () => {
    await acquireRefreshLock(env.DB, 'conn-1', 3);
    const second = await acquireRefreshLock(env.DB, 'conn-1', 3);
    expect(second).toBe(false);
  });

  it('allows different connections to lock independently', async () => {
    const first = await acquireRefreshLock(env.DB, 'conn-1', 3);
    const second = await acquireRefreshLock(env.DB, 'conn-2', 3);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('reclaims expired lock', async () => {
    // Insert an already-expired lock
    await env.DB.prepare(
      `INSERT INTO refresh_locks (connection_id, locked_at, expires_at)
       VALUES (?, datetime('now', '-10 seconds'), datetime('now', '-5 seconds'))`
    ).bind('conn-expired').run();

    const acquired = await acquireRefreshLock(env.DB, 'conn-expired', 3);
    expect(acquired).toBe(true);
  });
});

describe('cleanupExpiredRefreshLocks', () => {
  it('removes expired locks', async () => {
    // Insert expired lock
    await env.DB.prepare(
      `INSERT INTO refresh_locks (connection_id, locked_at, expires_at)
       VALUES (?, datetime('now', '-10 seconds'), datetime('now', '-5 seconds'))`
    ).bind('conn-expired').run();
    // Insert active lock
    await acquireRefreshLock(env.DB, 'conn-active', 300);

    await cleanupExpiredRefreshLocks(env.DB);

    const remaining = await env.DB.prepare('SELECT COUNT(*) as count FROM refresh_locks').first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });
});

describe('refresh cool-down KV key', () => {
  it('can write and read a cool-down key', async () => {
    const key = 'refresh_cooldown:conn-test';
    await env.KV.put(key, new Date().toISOString(), { expirationTtl: 60 });

    const value = await env.KV.get(key);
    expect(value).not.toBeNull();
  });

  it('cool-down key can be deleted', async () => {
    const key = 'refresh_cooldown:conn-test';
    await env.KV.put(key, new Date().toISOString(), { expirationTtl: 60 });
    await env.KV.delete(key);

    const value = await env.KV.get(key);
    expect(value).toBeNull();
  });
});
