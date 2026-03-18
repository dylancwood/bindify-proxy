import {
  getUserByStripeCustomerId,
  setStripeCustomerId,
  setUserPlan,
  setAccessUntil,
  upsertSubscription,
  updateSubscriptionStatus,
  getSubscriptionById,
  getSubscriptionsByUserId,
  getMaxConnections,
  setPastDueSince,
  getConnectionsByUserId,
} from '../db/queries';
import { suspendExcessConnections, reactivateSuspendedConnections } from './suspend';
import { stripeRequest } from './stripe';
import { withProxyCache } from '../proxy/kv-cache';
import { log } from '../logger';
import type { Env } from '../index';

interface StripeEvent {
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
]);

export function isHandledEvent(type: string): boolean {
  return HANDLED_EVENTS.has(type);
}

export async function processWebhookEvent(env: Env, event: StripeEvent): Promise<void> {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(env, event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(env, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(env, event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(env, event.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(env, event.data.object);
        break;
    }
  } catch (err) {
    log.error('Webhook handler failed', err, { eventType: event.type });
    throw err;
  }
}

async function updateUserCacheEntries(
  env: Env,
  userId: string,
  subscriptionStatus: string | null,
  pastDueSince: string | null,
  userPlan?: string,
  accessUntil?: string | null
): Promise<void> {
  const connections = await getConnectionsByUserId(env.DB, userId);
  await Promise.all(connections.map(conn =>
    withProxyCache(env, conn.secret_url_segment_1, null, async (entry, write) => {
      if (subscriptionStatus !== undefined) {
        entry.subscriptionStatus = subscriptionStatus;
        entry.subscriptionPastDueSince = pastDueSince;
      }
      if (userPlan !== undefined) {
        entry.user.plan = userPlan;
      }
      if (accessUntil !== undefined) {
        entry.user.accessUntil = accessUntil;
      }
      entry.cachedAt = new Date().toISOString();
      await write();
    })
  ));
}

async function handleCheckoutCompleted(env: Env, session: Record<string, unknown>): Promise<void> {
  const userId = session.client_reference_id as string | null;
  const stripeCustomerId = session.customer as string | null;
  const subscriptionId = session.subscription as string | null;

  if (!userId || !stripeCustomerId) {
    log.warn('Checkout session missing required fields', {
      handler: 'handleCheckoutCompleted',
      hasUserId: !!userId,
      hasCustomerId: !!stripeCustomerId,
    });
    return;
  }

  await setStripeCustomerId(env.DB, userId, stripeCustomerId);

  if (subscriptionId && env.STRIPE_SECRET_KEY) {
    const res = await stripeRequest(`/subscriptions/${subscriptionId}`, env.STRIPE_SECRET_KEY);
    if (res.ok) {
      const subscription = await res.json() as Record<string, unknown>;
      await handleSubscriptionUpdated(env, subscription);
    } else {
      log.warn('Failed to fetch subscription after checkout', {
        handler: 'handleCheckoutCompleted',
        subscriptionId,
        status: res.status,
      });
    }
  }
}

async function handleSubscriptionUpdated(env: Env, subscription: Record<string, unknown>): Promise<void> {
  // Validate required fields
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  const status = subscription.status;
  const items = subscription.items as { data?: unknown[] } | undefined;

  if (typeof customerId !== 'string') {
    throw new Error(`Invalid subscription payload: missing or invalid customer field`);
  }
  if (typeof subscriptionId !== 'string') {
    throw new Error(`Invalid subscription payload: missing or invalid id field`);
  }
  if (typeof status !== 'string') {
    throw new Error(`Invalid subscription payload: missing or invalid status field`);
  }
  if (!items?.data?.[0]) {
    throw new Error(`Invalid subscription payload: missing or empty items.data`);
  }

  const user = await getUserByStripeCustomerId(env.DB, customerId);
  if (!user) {
    log.warn('No user found for Stripe customer', {
      handler: 'handleSubscriptionUpdated',
      customerId,
    });
    return;
  }

  const item = items.data[0] as Record<string, unknown>;
  const quantity = item.quantity as number;
  const currentPeriodEnd = ((item.current_period_end ?? subscription.current_period_end) as number);

  if (typeof currentPeriodEnd !== 'number') {
    throw new Error(`Invalid subscription payload: missing current_period_end on item and subscription`);
  }

  await upsertSubscription(env.DB, {
    id: subscriptionId,
    user_id: user.id,
    quantity,
    status: status as 'active' | 'past_due' | 'canceled' | 'trialing',
    current_period_end: new Date(currentPeriodEnd * 1000).toISOString(),
  });

  // Handle cancellation: Stripe signals cancellation two ways:
  // 1. cancel_at_period_end: true (BIN-47)
  // 2. cancel_at set to a future timestamp (BIN-54)
  let newPlan: string | undefined;
  let newAccessUntil: string | null | undefined;
  if (status === 'active' || status === 'trialing') {
    const cancelAt = subscription.cancel_at as number | null;
    if (subscription.cancel_at_period_end || cancelAt) {
      newPlan = 'canceled';
      const accessUntilDate = cancelAt
        ? new Date(cancelAt * 1000).toISOString()
        : new Date(currentPeriodEnd * 1000).toISOString();
      newAccessUntil = accessUntilDate;
      await setUserPlan(env.DB, user.id, 'canceled');
      await setAccessUntil(env.DB, user.id, accessUntilDate);
    } else {
      newPlan = 'active';
      newAccessUntil = null;
      await setUserPlan(env.DB, user.id, 'active');
      await setAccessUntil(env.DB, user.id, null);
    }
  }

  const maxConnections = await getMaxConnections(env.DB, user.id);
  await reactivateSuspendedConnections(env, user.id, maxConnections);
  await suspendExcessConnections(env, user.id, maxConnections);

  // Update cache entries with new subscription status
  const updatedSubs = await getSubscriptionsByUserId(env.DB, user.id);
  const activeSub = updatedSubs.find(s => s.status === 'active' || s.status === 'trialing');
  const pastDueSub = updatedSubs.find(s => s.status === 'past_due');
  await updateUserCacheEntries(
    env,
    user.id,
    activeSub?.status ?? pastDueSub?.status ?? null,
    pastDueSub?.past_due_since ?? null,
    newPlan,
    newAccessUntil,
  );
}

async function handleSubscriptionDeleted(env: Env, subscription: Record<string, unknown>): Promise<void> {
  // Validate required fields
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  const currentPeriodEnd = subscription.current_period_end;

  if (typeof customerId !== 'string') {
    throw new Error(`Invalid subscription.deleted payload: missing or invalid customer field`);
  }
  if (typeof subscriptionId !== 'string') {
    throw new Error(`Invalid subscription.deleted payload: missing or invalid id field`);
  }
  if (typeof currentPeriodEnd !== 'number') {
    throw new Error(`Invalid subscription.deleted payload: missing or invalid current_period_end field`);
  }

  const user = await getUserByStripeCustomerId(env.DB, customerId);
  if (!user) {
    log.warn('No user found for Stripe customer', {
      handler: 'handleSubscriptionDeleted',
      customerId,
    });
    return;
  }

  const accessUntil = new Date(currentPeriodEnd * 1000).toISOString();

  await upsertSubscription(env.DB, {
    id: subscriptionId,
    user_id: user.id,
    quantity: 0,
    status: 'canceled',
    current_period_end: accessUntil,
  });

  await setUserPlan(env.DB, user.id, 'canceled');
  await setAccessUntil(env.DB, user.id, accessUntil);

  const maxConnections = await getMaxConnections(env.DB, user.id);
  await suspendExcessConnections(env, user.id, maxConnections);

  // Update cache entries
  await updateUserCacheEntries(
    env,
    user.id,
    null,
    null,
    'canceled',
    accessUntil,
  );
}

async function handleInvoicePaymentFailed(env: Env, invoice: Record<string, unknown>): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) {
    log.warn('Invoice payment_failed has no subscription (one-off invoice)', {
      handler: 'handleInvoicePaymentFailed',
    });
    return;
  }

  const sub = await getSubscriptionById(env.DB, subscriptionId);
  if (!sub) {
    log.warn('Subscription not found in DB for payment_failed', {
      handler: 'handleInvoicePaymentFailed',
      subscriptionId,
    });
    return;
  }

  await updateSubscriptionStatus(env.DB, subscriptionId, 'past_due');

  let pastDueSince = sub.past_due_since;
  if (!pastDueSince) {
    pastDueSince = new Date().toISOString();
    await setPastDueSince(env.DB, subscriptionId, pastDueSince);
  }

  // Update cache entries
  await updateUserCacheEntries(
    env,
    sub.user_id,
    'past_due',
    pastDueSince,
  );
}

async function handleInvoicePaid(env: Env, invoice: Record<string, unknown>): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) {
    log.warn('Invoice paid has no subscription (one-off invoice)', {
      handler: 'handleInvoicePaid',
    });
    return;
  }

  const sub = await getSubscriptionById(env.DB, subscriptionId);
  if (!sub) {
    log.warn('Subscription not found in DB for invoice.paid', {
      handler: 'handleInvoicePaid',
      subscriptionId,
    });
    return;
  }

  await updateSubscriptionStatus(env.DB, subscriptionId, 'active');
  await setPastDueSince(env.DB, subscriptionId, null);

  // Update cache entries
  await updateUserCacheEntries(
    env,
    sub.user_id,
    'active',
    null,
  );
}
