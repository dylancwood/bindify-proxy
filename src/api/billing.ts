import { stripeRequest } from '../billing/stripe';
import { getActiveSubscription, getActiveConnectionCount, upsertSubscription, getMaxConnections, setStripeCustomerId, getUserById } from '../db/queries';
import { reactivateSuspendedConnections, suspendExcessConnections } from '../billing/suspend';
import { processWebhookEvent } from '../billing/webhook';
import { log } from '../logger';
import type { Env } from '../index';

export async function handleCreateCheckout(
  userId: string,
  quantity: number,
  env: Env,
  returnUrl: string
): Promise<Response> {
  const response = await stripeRequest('/checkout/sessions', env.STRIPE_SECRET_KEY, {
    method: 'POST',
    body: {
      mode: 'subscription',
      'line_items[0][price]': env.STRIPE_PRICE_CONNECTIONS,
      'line_items[0][quantity]': String(quantity),
      'line_items[0][adjustable_quantity][enabled]': 'true',
      'line_items[0][adjustable_quantity][minimum]': '1',
      'line_items[0][adjustable_quantity][maximum]': '20',
      client_reference_id: userId,
      payment_method_collection: 'if_required',
      allow_promotion_codes: 'true',
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: returnUrl,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    return Response.json({ error: 'Failed to create checkout session', details: error }, { status: 500 });
  }

  const session = await response.json<{ url: string }>();
  return Response.json({ url: session.url });
}

export async function handleUpdateQuantity(
  db: D1Database,
  userId: string,
  quantity: number,
  env: Env
): Promise<Response> {
  if (quantity < 1) {
    return Response.json({ error: 'invalid_quantity', message: 'Quantity must be at least 1' }, { status: 400 });
  }

  const subscription = await getActiveSubscription(db, userId);
  if (!subscription) {
    return Response.json({ error: 'no_subscription', message: 'No active subscription found' }, { status: 400 });
  }

  const activeConnections = await getActiveConnectionCount(db, userId);
  if (quantity < activeConnections) {
    return Response.json({
      error: 'quantity_too_low',
      message: `Cannot reduce below active connections (${activeConnections}). Remove connections first.`,
    }, { status: 400 });
  }

  // Fetch subscription from Stripe to get the item ID
  const subResponse = await stripeRequest(`/subscriptions/${subscription.id}`, env.STRIPE_SECRET_KEY);
  if (!subResponse.ok) {
    return Response.json({ error: 'stripe_error', message: 'Failed to fetch subscription' }, { status: 500 });
  }
  const stripeSub = await subResponse.json<{ items: { data: Array<{ id: string }> } }>();
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) {
    return Response.json({ error: 'stripe_error', message: 'No subscription item found' }, { status: 500 });
  }

  // Update quantity via Stripe
  const updateResponse = await stripeRequest(`/subscriptions/${subscription.id}`, env.STRIPE_SECRET_KEY, {
    method: 'POST',
    body: {
      [`items[0][id]`]: itemId,
      [`items[0][quantity]`]: String(quantity),
      proration_behavior: 'create_prorations',
    },
  });

  if (!updateResponse.ok) {
    const error = await updateResponse.text();
    return Response.json({ error: 'stripe_error', message: 'Failed to update quantity', details: error }, { status: 500 });
  }

  // Parse Stripe-confirmed values and update D1 immediately
  const updatedSub = await updateResponse.json<{
    id: string;
    status: string;
    current_period_end: number;
    items: { data: Array<{ id: string; quantity: number }> };
  }>();
  const confirmedQuantity = updatedSub.items.data[0]?.quantity ?? quantity;
  const confirmedStatus = updatedSub.status as 'active' | 'past_due' | 'canceled' | 'trialing';
  const periodEnd = updatedSub.current_period_end
    ? new Date(updatedSub.current_period_end * 1000).toISOString()
    : subscription.current_period_end;

  await upsertSubscription(db, {
    id: subscription.id,
    user_id: userId,
    quantity: confirmedQuantity,
    status: confirmedStatus,
    current_period_end: periodEnd,
  });

  // Adjust connections based on new limit
  const maxConnections = await getMaxConnections(db, userId);
  await reactivateSuspendedConnections(env, userId, maxConnections);
  await suspendExcessConnections(env, userId, maxConnections);

  return Response.json({ success: true, quantity: confirmedQuantity });
}

export async function handleVerifyCheckout(
  userId: string,
  sessionId: string,
  env: Env
): Promise<Response> {
  // Fetch the checkout session from Stripe
  const res = await stripeRequest(`/checkout/sessions/${sessionId}`, env.STRIPE_SECRET_KEY);
  if (!res.ok) {
    log.warn('Failed to fetch checkout session for verification', { sessionId, status: res.status });
    return Response.json({ error: 'invalid_session', message: 'Could not verify checkout session' }, { status: 400 });
  }

  const session = await res.json<{
    client_reference_id: string | null;
    customer: string | null;
    subscription: string | null;
    payment_status: string;
  }>();

  // Verify this session belongs to the requesting user
  if (session.client_reference_id !== userId) {
    return Response.json({ error: 'unauthorized', message: 'Session does not belong to this user' }, { status: 403 });
  }

  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return Response.json({ error: 'not_paid', message: 'Checkout session has not been paid' }, { status: 400 });
  }

  // Check if subscription is already linked (webhook already handled it)
  const user = await getUserById(env.DB, userId);
  if (user?.stripe_customer_id && session.customer === user.stripe_customer_id) {
    // Already linked — return success without re-processing
    return Response.json({ success: true, already_linked: true });
  }

  // Link Stripe customer if not yet linked
  if (session.customer) {
    await setStripeCustomerId(env.DB, userId, session.customer);
  }

  // Process subscription if present
  if (session.subscription && env.STRIPE_SECRET_KEY) {
    const subRes = await stripeRequest(`/subscriptions/${session.subscription}`, env.STRIPE_SECRET_KEY);
    if (subRes.ok) {
      const subscription = await subRes.json() as Record<string, unknown>;
      // Re-use the webhook handler to process the subscription
      await processWebhookEvent(env, {
        type: 'customer.subscription.created',
        data: { object: subscription },
      });
    } else {
      log.warn('Failed to fetch subscription during checkout verification', {
        subscriptionId: session.subscription,
        status: subRes.status,
      });
    }
  }

  return Response.json({ success: true, already_linked: false });
}

export async function handleCreatePortal(
  stripeCustomerId: string,
  env: Env,
  returnUrl: string
): Promise<Response> {
  const response = await stripeRequest('/billing_portal/sessions', env.STRIPE_SECRET_KEY, {
    method: 'POST',
    body: {
      customer: stripeCustomerId,
      return_url: returnUrl,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    return Response.json({ error: 'Failed to create portal session', details: error }, { status: 500 });
  }

  const session = await response.json<{ url: string }>();
  return Response.json({ url: session.url });
}
