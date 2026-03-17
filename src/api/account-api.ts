import { getConnectionsByUserId, getSubscriptionsByUserId, deleteUserCascade } from '../db/queries';

export async function handleDeleteAccount(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  stripeCustomerId: string | null,
  stripeSecretKey: string,
  clerkSecretKey: string
): Promise<Response> {
  const errors: string[] = [];

  // 1. Cancel Stripe subscriptions + delete customer
  if (stripeCustomerId) {
    try {
      const subs = await getSubscriptionsByUserId(db, userId);
      for (const sub of subs) {
        if (sub.status === 'active' || sub.status === 'past_due' || sub.status === 'trialing') {
          await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${stripeSecretKey}` },
          });
        }
      }
      await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${stripeSecretKey}` },
      });
    } catch (e) {
      errors.push(`Stripe cleanup failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  // 2. Delete all KV tokens
  try {
    const connections = await getConnectionsByUserId(db, userId);
    for (const conn of connections) {
      await kv.put(`proxy:${conn.secret_url_segment_1}`, JSON.stringify({ schemaVersion: 0, deleted: true }), { expirationTtl: 300 });
    }
  } catch (e) {
    errors.push(`KV cleanup failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // 3. Delete all D1 data (subscriptions -> connections -> user)
  try {
    await deleteUserCascade(db, userId);
  } catch (e) {
    errors.push(`Database cleanup failed: ${e instanceof Error ? e.message : 'unknown'}`);
    return Response.json({ error: 'partial_failure', errors }, { status: 500 });
  }

  // 4. Delete Clerk user
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${clerkSecretKey}` },
    });
    if (!res.ok && res.status !== 404) {
      errors.push(`Clerk deletion failed: ${res.status}`);
    }
  } catch (e) {
    errors.push(`Clerk deletion failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  if (errors.length > 0) {
    return Response.json({ success: true, warnings: errors });
  }
  return Response.json({ success: true });
}
