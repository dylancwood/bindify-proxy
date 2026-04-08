import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { processWebhookEvent } from '../billing/webhook';
import { createUser, setStripeCustomerId, upsertSubscription } from '../db/queries';

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

CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    stripe_customer_id TEXT,
    user_id TEXT,
    data TEXT NOT NULL,
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

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM stripe_events').run();
  await env.DB.prepare('DELETE FROM subscriptions').run();
  await env.DB.prepare('DELETE FROM connection_events').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('Webhook validation: subscription events', () => {
  it('throws on missing customer in subscription.updated', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', items: { data: [{ quantity: 1 }] } } },
    })).rejects.toThrow(/customer/i);
  });

  it('throws on missing items in subscription.updated', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_2',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } },
    })).rejects.toThrow(/items/i);
  });

  it('throws on empty items.data in subscription.updated', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_3',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [] } } },
    })).rejects.toThrow(/items/i);
  });

  it('throws on missing customer in subscription.deleted', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_4',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', current_period_end: 1234567890 } },
    })).rejects.toThrow(/customer/i);
  });

  it('throws on missing current_period_end in subscription.deleted', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_5',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    })).rejects.toThrow(/current_period_end/i);
  });
});

describe('Webhook validation: invoice events', () => {
  it('does not throw when invoice.payment_failed has no subscription (returns silently with warning)', async () => {
    // Missing subscription is a valid case (one-off invoices) — should not throw
    await expect(processWebhookEvent(env, {
      id: 'evt_err_6',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_1' } },
    })).resolves.toBeUndefined();
  });

  it('does not throw when invoice.paid has no subscription (returns silently with warning)', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_7',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_1' } },
    })).resolves.toBeUndefined();
  });
});

describe('Webhook validation: checkout events', () => {
  it('does not throw when checkout has no client_reference_id (returns silently with warning)', async () => {
    await expect(processWebhookEvent(env, {
      id: 'evt_err_8',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1' } },
    })).resolves.toBeUndefined();
  });
});

describe('Webhook error propagation', () => {
  it('processWebhookEvent propagates handler errors', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_err', trialEnd);
    await setStripeCustomerId(env.DB, 'user_err', 'cus_err');

    // Missing items entirely — should throw a validation error
    await expect(processWebhookEvent(env, {
      id: 'evt_err_9',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_err', customer: 'cus_err', status: 'active' } },
    })).rejects.toThrow();
  });
});
