import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { processWebhookEvent } from '../billing/webhook';
import {
  createUser,
  getUserById,
  setStripeCustomerId,
  getSubscriptionById,
  upsertSubscription,
} from '../db/queries';

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
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

describe('Webhook: checkout.session.completed', () => {
  it('links stripe customer to user', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_checkout', trialEnd);

    await processWebhookEvent(env, {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_checkout',
          customer: 'cus_stripe_123',
        },
      },
    });

    const user = await getUserById(env.DB, 'user_checkout');
    expect(user).not.toBeNull();
    expect(user!.stripe_customer_id).toBe('cus_stripe_123');
  });

  it('writes bindify_user_id to Stripe Customer metadata (BIN-382)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_meta', trialEnd);

    // Mock fetch to intercept the Stripe API call
    const originalFetch = globalThis.fetch;
    const fetchCalls: { url: string; body: string }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.stripe.com/v1/customers/')) {
        fetchCalls.push({ url, body: init?.body as string });
        return new Response(JSON.stringify({ id: 'cus_meta_123' }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      await processWebhookEvent(env, {
        id: 'evt_meta_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: 'user_meta',
            customer: 'cus_meta_123',
          },
        },
      });

      const metadataCall = fetchCalls.find(c => c.url.includes('/customers/cus_meta_123'));
      expect(metadataCall).toBeDefined();
      expect(metadataCall!.body).toContain('metadata%5Bbindify_user_id%5D=user_meta');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Webhook: customer.subscription.created', () => {
  it('creates subscription and updates user plan', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_sub_cre', trialEnd);
    await setStripeCustomerId(env.DB, 'user_sub_cre', 'cus_sub_cre');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await processWebhookEvent(env, {
      id: 'evt_sub_cre_1',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_created_1',
          customer: 'cus_sub_cre',
          status: 'active',
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 3, current_period_end: periodEnd }],
          },
        },
      },
    });

    const sub = await getSubscriptionById(env.DB, 'sub_created_1');
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('active');
    expect(sub!.quantity).toBe(3);

    const user = await getUserById(env.DB, 'user_sub_cre');
    expect(user!.plan).toBe('active');
  });
});

describe('Webhook: customer.subscription.updated', () => {
  it('updates subscription in D1', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_sub_upd', trialEnd);
    await setStripeCustomerId(env.DB, 'user_sub_upd', 'cus_sub_upd');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await processWebhookEvent(env, {
      id: 'evt_sub_upd_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_updated_1',
          customer: 'cus_sub_upd',
          status: 'active',
          current_period_end: periodEnd,
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 5 }],
          },
        },
      },
    });

    const sub = await getSubscriptionById(env.DB, 'sub_updated_1');
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('active');
    expect(sub!.quantity).toBe(5);

    const user = await getUserById(env.DB, 'user_sub_upd');
    expect(user!.plan).toBe('active');
  });

  it('sets plan to canceled when cancel_at_period_end is true (BIN-47)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_cancel_end', trialEnd);
    await setStripeCustomerId(env.DB, 'user_cancel_end', 'cus_cancel_end');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await processWebhookEvent(env, {
      id: 'evt_sub_upd_cancel_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_cancel_end',
          customer: 'cus_cancel_end',
          status: 'active',
          cancel_at_period_end: true,
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 3, current_period_end: periodEnd }],
          },
        },
      },
    });

    const user = await getUserById(env.DB, 'user_cancel_end');
    expect(user!.plan).toBe('canceled');
    expect(user!.access_until).not.toBeNull();
    const accessUntil = new Date(user!.access_until!).getTime();
    expect(accessUntil).toBe(periodEnd * 1000);
  });

  it('restores plan when cancel_at_period_end is false (resubscription, BIN-47)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_resub', trialEnd);
    await setStripeCustomerId(env.DB, 'user_resub', 'cus_resub');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    // First: cancel at period end
    await processWebhookEvent(env, {
      id: 'evt_resub_cancel_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_resub',
          customer: 'cus_resub',
          status: 'active',
          cancel_at_period_end: true,
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 1, current_period_end: periodEnd }],
          },
        },
      },
    });

    const canceledUser = await getUserById(env.DB, 'user_resub');
    expect(canceledUser!.plan).toBe('canceled');

    // Then: resubscribe (cancel_at_period_end flipped to false)
    await processWebhookEvent(env, {
      id: 'evt_resub_active_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_resub',
          customer: 'cus_resub',
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 1, current_period_end: periodEnd }],
          },
        },
      },
    });

    const resubbedUser = await getUserById(env.DB, 'user_resub');
    expect(resubbedUser!.plan).toBe('active');
    expect(resubbedUser!.access_until).toBeNull();
  });

  it('sets plan to canceled when cancel_at is set (BIN-54)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_cancel_at', trialEnd);
    await setStripeCustomerId(env.DB, 'user_cancel_at', 'cus_cancel_at');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const cancelAt = Math.floor(Date.now() / 1000) + 31 * 24 * 60 * 60;

    await processWebhookEvent(env, {
      id: 'evt_cancel_at_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_cancel_at',
          customer: 'cus_cancel_at',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: cancelAt,
          items: {
            data: [{ price: { id: 'price_connections' }, quantity: 2, current_period_end: periodEnd }],
          },
        },
      },
    });

    const user = await getUserById(env.DB, 'user_cancel_at');
    expect(user!.plan).toBe('canceled');
    expect(user!.access_until).not.toBeNull();
    const accessUntil = new Date(user!.access_until!).getTime();
    // Should use cancel_at, NOT currentPeriodEnd
    expect(accessUntil).toBe(cancelAt * 1000);
  });
});

describe('Webhook: customer.subscription.deleted', () => {
  it('extracts current_period_end from items.data when absent on subscription root (BIN-360)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_del_item', trialEnd);
    await setStripeCustomerId(env.DB, 'user_del_item', 'cus_del_item');

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await processWebhookEvent(env, {
      id: 'evt_sub_del_item_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_del_item',
          customer: 'cus_del_item',
          status: 'canceled',
          items: {
            data: [{ quantity: 1, current_period_end: periodEnd }],
          },
        },
      },
    });

    const user = await getUserById(env.DB, 'user_del_item');
    expect(user!.plan).toBe('canceled');
    expect(user!.access_until).toBe(new Date(periodEnd * 1000).toISOString());

    const sub = await getSubscriptionById(env.DB, 'sub_del_item');
    expect(sub!.status).toBe('canceled');
    expect(sub!.quantity).toBe(0);
  });

  it('falls back to ended_at when current_period_end is absent everywhere (BIN-360)', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_del_ended', trialEnd);
    await setStripeCustomerId(env.DB, 'user_del_ended', 'cus_del_ended');

    const endedAt = Math.floor(Date.now() / 1000);

    await processWebhookEvent(env, {
      id: 'evt_sub_del_ended_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_del_ended',
          customer: 'cus_del_ended',
          status: 'canceled',
          ended_at: endedAt,
        },
      },
    });

    const user = await getUserById(env.DB, 'user_del_ended');
    expect(user!.plan).toBe('canceled');
    expect(user!.access_until).toBe(new Date(endedAt * 1000).toISOString());
  });
});

describe('Webhook: invoice.payment_failed', () => {
  it('sets subscription to past_due', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_pf', trialEnd);
    await setStripeCustomerId(env.DB, 'user_pf', 'cus_pf');

    await upsertSubscription(env.DB, {
      id: 'sub_pf_1',
      user_id: 'user_pf',

      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await processWebhookEvent(env, {
      id: 'evt_pf_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          subscription: 'sub_pf_1',
          customer: 'cus_pf',
        },
      },
    });

    const sub = await getSubscriptionById(env.DB, 'sub_pf_1');
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('past_due');
  });

  it('sets past_due_since timestamp when payment fails', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_pf_ts', trialEnd);
    await setStripeCustomerId(env.DB, 'user_pf_ts', 'cus_pf_ts');

    await upsertSubscription(env.DB, {
      id: 'sub_pf_ts',
      user_id: 'user_pf_ts',

      quantity: 1,
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const before = Date.now();
    await processWebhookEvent(env, {
      id: 'evt_pf_ts_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          subscription: 'sub_pf_ts',
          customer: 'cus_pf_ts',
        },
      },
    });

    const sub = await getSubscriptionById(env.DB, 'sub_pf_ts');
    expect(sub).not.toBeNull();
    expect(sub!.past_due_since).not.toBeNull();
    const pastDueTime = new Date(sub!.past_due_since!).getTime();
    expect(pastDueTime).toBeGreaterThanOrEqual(before - 1000);
    expect(pastDueTime).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('Webhook: invoice.paid', () => {
  it('clears past_due and restores access', async () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await createUser(env.DB, 'user_ip', trialEnd);
    await setStripeCustomerId(env.DB, 'user_ip', 'cus_ip');

    await upsertSubscription(env.DB, {
      id: 'sub_ip_1',
      user_id: 'user_ip',

      quantity: 2,
      status: 'past_due',
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await processWebhookEvent(env, {
      id: 'evt_ip_1',
      type: 'invoice.paid',
      data: {
        object: {
          subscription: 'sub_ip_1',
          customer: 'cus_ip',
        },
      },
    });

    const sub = await getSubscriptionById(env.DB, 'sub_ip_1');
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('active');
    expect(sub!.past_due_since).toBeNull();
  });
});
