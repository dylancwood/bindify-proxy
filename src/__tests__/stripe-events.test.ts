import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { logStripeEvent, getStripeEvent, deleteExpiredStripeEvents } from '../db/stripe-events';

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
CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    stripe_customer_id TEXT,
    user_id TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

beforeAll(async () => {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM stripe_events').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('logStripeEvent', () => {
  it('inserts a webhook event', async () => {
    const event = {
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_abc', client_reference_id: 'user_1' } },
    };

    await logStripeEvent(env.DB, event);

    const row = await getStripeEvent(env.DB, 'evt_test_123');
    expect(row).not.toBeNull();
    expect(row!.type).toBe('checkout.session.completed');
    expect(row!.stripe_customer_id).toBe('cus_abc');
    expect(row!.user_id).toBeNull();
    expect(JSON.parse(row!.data)).toEqual(event);
  });

  it('deduplicates by event ID (INSERT OR IGNORE)', async () => {
    const event = {
      id: 'evt_dup_1',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_xyz' } },
    };

    await logStripeEvent(env.DB, event);
    await logStripeEvent(env.DB, event);

    const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM stripe_events WHERE id = ?')
      .bind('evt_dup_1').first<{ cnt: number }>();
    expect(count!.cnt).toBe(1);
  });

  it('resolves user_id from stripe_customer_id when user exists', async () => {
    await env.DB.prepare('INSERT INTO users (id, stripe_customer_id) VALUES (?, ?)')
      .bind('user_resolved', 'cus_known').run();

    const event = {
      id: 'evt_resolve_1',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_known' } },
    };

    await logStripeEvent(env.DB, event);

    const row = await getStripeEvent(env.DB, 'evt_resolve_1');
    expect(row!.user_id).toBe('user_resolved');
  });
});

describe('deleteExpiredStripeEvents', () => {
  it('deletes events older than the retention period', async () => {
    await env.DB.prepare(
      `INSERT INTO stripe_events (id, type, data, created_at) VALUES (?, ?, ?, datetime('now', '-91 days'))`
    ).bind('evt_old', 'test', '{}').run();

    await env.DB.prepare(
      `INSERT INTO stripe_events (id, type, data) VALUES (?, ?, ?)`
    ).bind('evt_new', 'test', '{}').run();

    const deleted = await deleteExpiredStripeEvents(env.DB, 90);

    expect(deleted).toBe(1);
    expect(await getStripeEvent(env.DB, 'evt_old')).toBeNull();
    expect(await getStripeEvent(env.DB, 'evt_new')).not.toBeNull();
  });
});
