import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureUser } from '../auth/middleware';

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
`;

describe('ensureUser email capture', () => {
  beforeAll(async () => {
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM users').run();
  });

  it('stores email when creating a new user', async () => {
    const { user, isNew } = await ensureUser(env.DB, 'user_1', { email: 'alice@example.com' });
    expect(user.email).toBe('alice@example.com');
    expect(isNew).toBe(true);
    const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind('user_1').first<{ email: string }>();
    expect(row?.email).toBe('alice@example.com');
  });

  it('updates email for existing user when email changes', async () => {
    await ensureUser(env.DB, 'user_2', { email: 'old@example.com' });
    const { user: updated, isNew } = await ensureUser(env.DB, 'user_2', { email: 'new@example.com' });
    expect(updated.email).toBe('new@example.com');
    expect(isNew).toBe(false);
  });

  it('works without email (backward compatible)', async () => {
    const { user, isNew } = await ensureUser(env.DB, 'user_3');
    expect(user.email).toBeNull();
    expect(isNew).toBe(true);
  });
});
