import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateCheckout, handleCreatePortal, handleUpdateQuantity, handleVerifyCheckout } from '../api/billing';

vi.mock('../billing/stripe', () => ({
  stripeRequest: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  getActiveSubscription: vi.fn(),
  getActiveConnectionCount: vi.fn(),
  upsertSubscription: vi.fn(),
  getMaxConnections: vi.fn(),
  setStripeCustomerId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../billing/suspend', () => ({
  reactivateSuspendedConnections: vi.fn(),
  suspendExcessConnections: vi.fn(),
}));

vi.mock('../billing/webhook', () => ({
  processWebhookEvent: vi.fn(),
}));

vi.mock('../logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { stripeRequest } from '../billing/stripe';
import { getActiveSubscription, getActiveConnectionCount, upsertSubscription, getMaxConnections, setStripeCustomerId, getUserById } from '../db/queries';
import { reactivateSuspendedConnections, suspendExcessConnections } from '../billing/suspend';
import { processWebhookEvent } from '../billing/webhook';
const mockStripeRequest = vi.mocked(stripeRequest);
const mockGetActiveSubscription = vi.mocked(getActiveSubscription);
const mockGetActiveConnectionCount = vi.mocked(getActiveConnectionCount);
const mockUpsertSubscription = vi.mocked(upsertSubscription);
const mockGetMaxConnections = vi.mocked(getMaxConnections);
const mockReactivate = vi.mocked(reactivateSuspendedConnections);
const mockSuspend = vi.mocked(suspendExcessConnections);
const mockSetStripeCustomerId = vi.mocked(setStripeCustomerId);
const mockGetUserById = vi.mocked(getUserById);
const mockProcessWebhookEvent = vi.mocked(processWebhookEvent);

const mockEnv = {
  STRIPE_SECRET_KEY: 'sk_test_mock',
  STRIPE_PRICE_CONNECTIONS: 'price_connections_123',
  DB: {} as D1Database,
} as any;

const mockDb = {} as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleCreateCheckout', () => {
  it('uses connections price with quantity', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/test' })
    );

    await handleCreateCheckout('user_1', 1, mockEnv, 'https://app.bindify.dev/dashboard');

    expect(mockStripeRequest).toHaveBeenCalledOnce();
    const [path, key, options] = mockStripeRequest.mock.calls[0];
    expect(path).toBe('/checkout/sessions');
    expect(options!.body).toMatchObject({
      'line_items[0][price]': 'price_connections_123',
      'line_items[0][quantity]': '1',
    });
  });

  it('passes custom quantity to checkout', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/test' })
    );

    await handleCreateCheckout('user_1', 3, mockEnv, 'https://app.bindify.dev/dashboard');

    const [, , options] = mockStripeRequest.mock.calls[0];
    expect(options!.body!['line_items[0][quantity]']).toBe('3');
  });

  it('enables promotion codes at checkout', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/test' })
    );

    await handleCreateCheckout('user_1', 1, mockEnv, 'https://app.bindify.dev/dashboard');

    const [, , options] = mockStripeRequest.mock.calls[0];
    expect(options!.body!.allow_promotion_codes).toBe('true');
  });

  it('sets client_reference_id to userId', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/test' })
    );

    await handleCreateCheckout('user_xyz', 1, mockEnv, 'https://app.bindify.dev/dashboard');

    const [, , options] = mockStripeRequest.mock.calls[0];
    expect(options!.body!.client_reference_id).toBe('user_xyz');
  });

  it('returns checkout URL from Stripe response', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/c/pay_abc123' })
    );

    const response = await handleCreateCheckout('user_1', 1, mockEnv, 'https://app.bindify.dev/dashboard');
    const body = await response.json() as { url: string };

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/c/pay_abc123');
  });

  it('returns 500 when Stripe fails', async () => {
    mockStripeRequest.mockResolvedValue(
      new Response('Stripe error', { status: 400 })
    );

    const response = await handleCreateCheckout('user_1', 1, mockEnv, 'https://app.bindify.dev/dashboard');

    expect(response.status).toBe(500);
  });

  it('enables adjustable quantity with min 1 and max 20', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://checkout.stripe.com/test' })
    );

    await handleCreateCheckout('user_1', 3, mockEnv, 'https://app.bindify.dev/dashboard');

    const [, , options] = mockStripeRequest.mock.calls[0];
    expect(options!.body).toMatchObject({
      'line_items[0][adjustable_quantity][enabled]': 'true',
      'line_items[0][adjustable_quantity][minimum]': '1',
      'line_items[0][adjustable_quantity][maximum]': '20',
    });
  });
});

describe('handleUpdateQuantity', () => {
  it('updates subscription quantity via Stripe', async () => {
    mockGetActiveSubscription.mockResolvedValue({
      id: 'sub_123',
      user_id: 'user_1',
      quantity: 1,
      status: 'active',
      current_period_end: new Date().toISOString(),
      past_due_since: null,
      created_at: new Date().toISOString(),
    });
    mockGetActiveConnectionCount.mockResolvedValue(1);
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        items: { data: [{ id: 'si_abc', quantity: 1 }] },
      })
    );
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        status: 'active',
        current_period_end: 1743465600,
        items: { data: [{ id: 'si_abc', quantity: 3 }] },
      })
    );
    mockGetMaxConnections.mockResolvedValue(3);

    const response = await handleUpdateQuantity(mockDb, 'user_1', 3, mockEnv);
    expect(response.status).toBe(200);
  });

  it('writes Stripe-confirmed quantity to D1 and runs suspend/reactivate', async () => {
    mockGetActiveSubscription.mockResolvedValue({
      id: 'sub_123',
      user_id: 'user_1',
      quantity: 1,
      status: 'active',
      current_period_end: '2026-04-01T00:00:00.000Z',
      past_due_since: null,
      created_at: new Date().toISOString(),
    });
    mockGetActiveConnectionCount.mockResolvedValue(1);
    mockGetMaxConnections.mockResolvedValue(3);

    // First call: fetch subscription to get item ID
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        items: { data: [{ id: 'si_abc', quantity: 1 }] },
      })
    );
    // Second call: update subscription — Stripe confirms quantity 3
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        status: 'active',
        current_period_end: 1743465600,
        items: { data: [{ id: 'si_abc', quantity: 3 }] },
      })
    );

    const response = await handleUpdateQuantity(mockDb, 'user_1', 3, mockEnv);
    const body = await response.json() as { success: boolean; quantity: number };

    expect(response.status).toBe(200);
    expect(body.quantity).toBe(3);

    // Verify D1 was updated with Stripe-confirmed values
    expect(mockUpsertSubscription).toHaveBeenCalledWith(mockDb, {
      id: 'sub_123',
      user_id: 'user_1',
      quantity: 3,
      status: 'active',
      current_period_end: expect.any(String),
    });

    // Verify suspend/reactivate ran
    expect(mockReactivate).toHaveBeenCalledWith(mockEnv, 'user_1', 3);
    expect(mockSuspend).toHaveBeenCalledWith(mockEnv, 'user_1', 3);
  });

  it('rejects quantity less than 1', async () => {
    const response = await handleUpdateQuantity(mockDb, 'user_1', 0, mockEnv);
    expect(response.status).toBe(400);
  });

  it('rejects quantity less than active connections', async () => {
    mockGetActiveSubscription.mockResolvedValue({
      id: 'sub_123',
      user_id: 'user_1',
      quantity: 3,
      status: 'active',
      current_period_end: new Date().toISOString(),
      past_due_since: null,
      created_at: new Date().toISOString(),
    });
    mockGetActiveConnectionCount.mockResolvedValue(3);

    const response = await handleUpdateQuantity(mockDb, 'user_1', 2, mockEnv);
    expect(response.status).toBe(400);
  });

  it('falls back to existing period end when Stripe omits current_period_end', async () => {
    const existingPeriodEnd = '2026-04-01T00:00:00.000Z';
    mockGetActiveSubscription.mockResolvedValue({
      id: 'sub_123',
      user_id: 'user_1',
      quantity: 1,
      status: 'active',
      current_period_end: existingPeriodEnd,
      past_due_since: null,
      created_at: new Date().toISOString(),
    });
    mockGetActiveConnectionCount.mockResolvedValue(1);
    mockGetMaxConnections.mockResolvedValue(3);

    // First call: fetch subscription to get item ID
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        items: { data: [{ id: 'si_abc', quantity: 1 }] },
      })
    );
    // Second call: Stripe response missing current_period_end
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_123',
        status: 'active',
        items: { data: [{ id: 'si_abc', quantity: 3 }] },
      })
    );

    const response = await handleUpdateQuantity(mockDb, 'user_1', 3, mockEnv);
    const body = await response.json() as { success: boolean; quantity: number };

    expect(response.status).toBe(200);
    expect(body.quantity).toBe(3);

    // Should use existing subscription's period end as fallback
    expect(mockUpsertSubscription).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      current_period_end: existingPeriodEnd,
    }));
  });

  it('rejects when no active subscription', async () => {
    mockGetActiveSubscription.mockResolvedValue(null);

    const response = await handleUpdateQuantity(mockDb, 'user_1', 3, mockEnv);
    expect(response.status).toBe(400);
  });
});

describe('handleVerifyCheckout', () => {
  it('verifies checkout session and links subscription', async () => {
    // Stripe returns the checkout session
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        client_reference_id: 'user_1',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        payment_status: 'paid',
      })
    );
    mockGetUserById.mockResolvedValue({ id: 'user_1', stripe_customer_id: null } as any);
    // Stripe returns the subscription details
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        id: 'sub_xyz',
        customer: 'cus_abc',
        status: 'active',
        items: { data: [{ id: 'si_1', quantity: 1, current_period_end: 1743465600 }] },
      })
    );
    mockProcessWebhookEvent.mockResolvedValue(undefined);

    const response = await handleVerifyCheckout('user_1', 'cs_test_123', mockEnv);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.already_linked).toBe(false);
    expect(mockSetStripeCustomerId).toHaveBeenCalledWith(mockEnv.DB, 'user_1', 'cus_abc');
    expect(mockProcessWebhookEvent).toHaveBeenCalled();
  });

  it('returns already_linked when webhook already processed', async () => {
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        client_reference_id: 'user_1',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        payment_status: 'paid',
      })
    );
    mockGetUserById.mockResolvedValue({ id: 'user_1', stripe_customer_id: 'cus_abc' } as any);

    const response = await handleVerifyCheckout('user_1', 'cs_test_123', mockEnv);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.already_linked).toBe(true);
    expect(mockSetStripeCustomerId).not.toHaveBeenCalled();
  });

  it('rejects session belonging to different user', async () => {
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        client_reference_id: 'user_other',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        payment_status: 'paid',
      })
    );

    const response = await handleVerifyCheckout('user_1', 'cs_test_123', mockEnv);
    expect(response.status).toBe(403);
  });

  it('rejects unpaid session', async () => {
    mockStripeRequest.mockResolvedValueOnce(
      Response.json({
        client_reference_id: 'user_1',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        payment_status: 'unpaid',
      })
    );

    const response = await handleVerifyCheckout('user_1', 'cs_test_123', mockEnv);
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid session ID', async () => {
    mockStripeRequest.mockResolvedValueOnce(
      new Response('Not found', { status: 404 })
    );

    const response = await handleVerifyCheckout('user_1', 'cs_invalid', mockEnv);
    expect(response.status).toBe(400);
  });
});

describe('handleCreatePortal', () => {
  it('creates portal session for customer', async () => {
    mockStripeRequest.mockResolvedValue(
      Response.json({ url: 'https://billing.stripe.com/p/session_abc' })
    );

    const response = await handleCreatePortal('cus_123', mockEnv, 'https://app.bindify.dev/dashboard');
    const body = await response.json() as { url: string };

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://billing.stripe.com/p/session_abc');
  });

  it('returns 500 when Stripe fails', async () => {
    mockStripeRequest.mockResolvedValue(
      new Response('error', { status: 500 })
    );

    const response = await handleCreatePortal('cus_123', mockEnv, 'https://app.bindify.dev/dashboard');
    expect(response.status).toBe(500);
  });
});
