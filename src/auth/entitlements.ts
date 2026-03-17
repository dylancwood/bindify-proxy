import { getUserById, getMaxConnections, getActiveConnectionCount, getSubscriptionsByUserId } from '../db/queries';

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface CanConnectResult {
  allowed: boolean;
  reason?: string;
  maxConnections?: number;
  activeConnections?: number;
}

export interface AccessActiveResult {
  active: boolean;
  reason?: string;
}

export async function checkCanConnect(db: D1Database, userId: string, excludeConnectionId?: string): Promise<CanConnectResult> {
  const maxConnections = await getMaxConnections(db, userId);
  const activeConnections = await getActiveConnectionCount(db, userId, excludeConnectionId);

  if (maxConnections === 0) {
    const user = await getUserById(db, userId);
    if (!user) {
      return { allowed: false, reason: 'User not found', maxConnections: 0, activeConnections: 0 };
    }

    if (user.plan === 'free_trial' && user.trial_ends_at) {
      const trialEnd = new Date(user.trial_ends_at);
      if (trialEnd <= new Date()) {
        return {
          allowed: false,
          reason: 'Free trial has expired. Please subscribe to add connections.',
          maxConnections: 0,
          activeConnections,
        };
      }
    }

    return {
      allowed: false,
      reason: 'No active subscription. Please subscribe to add connections.',
      maxConnections: 0,
      activeConnections,
    };
  }

  if (activeConnections >= maxConnections) {
    return {
      allowed: false,
      reason: `Connection limit reached (${activeConnections}/${maxConnections}). Upgrade your plan for more connections.`,
      maxConnections,
      activeConnections,
    };
  }

  return { allowed: true, maxConnections, activeConnections };
}

export async function checkAccessActive(db: D1Database, userId: string): Promise<AccessActiveResult> {
  const user = await getUserById(db, userId);
  if (!user) {
    return { active: false, reason: 'User not found' };
  }

  // Free trial: check trial_ends_at
  if (user.plan === 'free_trial') {
    if (!user.trial_ends_at) {
      // Trial not set, but check for subscriptions (webhook race condition)
      const subscriptions = await getSubscriptionsByUserId(db, userId);
      if (subscriptions.some(s => s.status === 'active' || s.status === 'trialing')) {
        return { active: true };
      }
      return { active: false, reason: 'No trial period set' };
    }
    const trialEnd = new Date(user.trial_ends_at);
    if (trialEnd > new Date()) {
      return { active: true };
    }
    // Trial expired, but check for subscriptions (webhook race condition)
    const subscriptions = await getSubscriptionsByUserId(db, userId);
    if (subscriptions.some(s => s.status === 'active' || s.status === 'trialing')) {
      return { active: true };
    }
    return { active: false, reason: 'Free trial has expired' };
  }

  // Canceled: check access_until
  if (user.plan === 'canceled') {
    if (user.access_until) {
      const accessEnd = new Date(user.access_until);
      if (accessEnd > new Date()) {
        return { active: true };
      }
    }
    return { active: false, reason: 'Subscription canceled and access period ended' };
  }

  // Check subscriptions
  const subscriptions = await getSubscriptionsByUserId(db, userId);

  // If any subscription is active or trialing, allow access
  const hasActive = subscriptions.some(s => s.status === 'active' || s.status === 'trialing');
  if (hasActive) {
    return { active: true };
  }

  // If any subscription is past_due, check grace period (3 days)
  const pastDueSub = subscriptions.find(s => s.status === 'past_due');
  if (pastDueSub && pastDueSub.past_due_since) {
    const pastDueStart = new Date(pastDueSub.past_due_since).getTime();
    const elapsed = Date.now() - pastDueStart;
    if (elapsed < GRACE_PERIOD_MS) {
      return { active: true };
    }
    return { active: false, reason: 'Payment past due for more than 3 days' };
  }

  return { active: false, reason: 'No active subscription' };
}
