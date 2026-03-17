import { ensureUser } from '../auth/middleware';
import { getActiveConnectionCount, getMaxConnections, getSubscriptionConnectionCount } from '../db/queries';
import { suspendExcessConnections } from '../billing/suspend';
import type { Env } from '../index';

export async function handleGetMe(env: Env, userId: string): Promise<Response> {
  const { user } = await ensureUser(env.DB, userId);

  const [activeConnections, maxConnections, paidConnections] = await Promise.all([
    getActiveConnectionCount(env.DB, userId),
    getMaxConnections(env.DB, userId),
    getSubscriptionConnectionCount(env.DB, userId),
  ]);

  // Lazy suspension: if connections exceed max (e.g. trial expired), suspend excess
  if (activeConnections > maxConnections) {
    await suspendExcessConnections(env, userId, maxConnections);
  }

  return Response.json({
    id: user.id,
    plan: user.plan,
    max_connections: maxConnections,
    active_connections: Math.min(activeConnections, maxConnections),
    trial_ends_at: user.trial_ends_at,
    access_until: user.access_until,
    paid_connections: paidConnections,
  });
}
