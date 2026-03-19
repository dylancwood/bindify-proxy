import type { User, Connection, Subscription } from '@bindify/types';

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function createUser(db: D1Database, id: string, trialEndsAt: string, email?: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (id, plan, trial_ends_at, email) VALUES (?, ?, ?, ?)')
    .bind(id, 'free_trial', trialEndsAt, email ?? null)
    .run();
}

export async function updateUserEmail(db: D1Database, id: string, email: string): Promise<void> {
  await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, id).run();
}

export async function getConnectionsByUserId(db: D1Database, userId: string): Promise<Connection[]> {
  const result = await db
    .prepare('SELECT * FROM connections WHERE user_id = ?')
    .bind(userId)
    .all<Connection>();
  return result.results;
}

export async function getConnectionById(db: D1Database, id: string): Promise<Connection | null> {
  return db.prepare('SELECT * FROM connections WHERE id = ?').bind(id).first<Connection>();
}

export async function getConnectionBySecret1(
  db: D1Database,
  secret1: string
): Promise<Connection | null> {
  return db
    .prepare('SELECT * FROM connections WHERE secret_url_segment_1 = ?')
    .bind(secret1)
    .first<Connection>();
}

export async function createConnection(db: D1Database, connection: Omit<Connection, 'created_at' | 'last_used_at' | 'last_refreshed_at' | 'suspended_at' | 'metadata' | 'auth_mode' | 'application' | 'label' | 'encrypted_tokens' | 'key_fingerprint'> & { auth_mode?: string | null; application?: string | null; label?: string | null; encrypted_tokens?: string | null; key_fingerprint?: string; metadata?: string | null }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections (id, user_id, service, secret_url_segment_1, status, key_storage_mode, auth_type, auth_mode, application, label, dcr_registration, encrypted_tokens, needs_reauth_at, key_fingerprint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      connection.id,
      connection.user_id,
      connection.service,
      connection.secret_url_segment_1,
      connection.status,
      connection.key_storage_mode,
      connection.auth_type,
      connection.auth_mode ?? null,
      connection.application ?? null,
      connection.label ?? null,
      connection.dcr_registration ?? null,
      connection.encrypted_tokens ?? null,
      connection.needs_reauth_at ?? null,
      connection.key_fingerprint ?? '',
      connection.metadata ?? null
    )
    .run();
}

export async function updateConnectionLabel(db: D1Database, id: string, label: string): Promise<void> {
  await db.prepare('UPDATE connections SET label = ? WHERE id = ?').bind(label, id).run();
}

export async function updateConnectionStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db
    .prepare('UPDATE connections SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
}

export async function setSuspendedAt(db: D1Database, id: string, suspendedAt: string | null): Promise<void> {
  await db
    .prepare('UPDATE connections SET suspended_at = ? WHERE id = ?')
    .bind(suspendedAt, id)
    .run();
}

export async function deleteConnection(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM connections WHERE id = ?').bind(id).run();
}

export async function updateConnectionLastUsed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE connections SET last_used_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export async function getActiveConnectionCount(db: D1Database, userId: string, excludeConnectionId?: string): Promise<number> {
  if (excludeConnectionId) {
    const result = await db
      .prepare("SELECT COUNT(*) as count FROM connections WHERE user_id = ? AND status != 'suspended' AND id != ?")
      .bind(userId, excludeConnectionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM connections WHERE user_id = ? AND status != 'suspended'")
    .bind(userId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function getSubscriptionConnectionCount(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) as total
      FROM subscriptions
      WHERE user_id = ? AND status IN ('active', 'trialing')`
    )
    .bind(userId)
    .first<{ total: number }>();
  return result?.total ?? 0;
}

export async function getMaxConnections(db: D1Database, userId: string): Promise<number> {
  const user = await getUserById(db, userId);
  if (!user) return 0;

  const subscriptionMax = await getSubscriptionConnectionCount(db, userId);

  // Trial allowance applies regardless of plan, as long as trial hasn't expired
  if (user.trial_ends_at) {
    const trialEnd = new Date(user.trial_ends_at);
    if (trialEnd > new Date()) {
      return Math.max(2, subscriptionMax);
    }
  }

  return subscriptionMax;
}

export async function getUserByStripeCustomerId(db: D1Database, stripeCustomerId: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(stripeCustomerId).first<User>();
}

export async function setStripeCustomerId(db: D1Database, userId: string, stripeCustomerId: string): Promise<void> {
  await db
    .prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
    .bind(stripeCustomerId, userId)
    .run();
}

export async function setUserPlan(db: D1Database, userId: string, plan: string): Promise<void> {
  await db
    .prepare('UPDATE users SET plan = ? WHERE id = ?')
    .bind(plan, userId)
    .run();
}

export async function setAccessUntil(db: D1Database, userId: string, accessUntil: string | null): Promise<void> {
  await db
    .prepare('UPDATE users SET access_until = ? WHERE id = ?')
    .bind(accessUntil, userId)
    .run();
}

export async function getSubscriptionById(db: D1Database, id: string): Promise<Subscription | null> {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<Subscription>();
}

export async function getSubscriptionsByUserId(db: D1Database, userId: string): Promise<Subscription[]> {
  const result = await db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<Subscription>();
  return result.results;
}

export async function updateSubscriptionStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db
    .prepare('UPDATE subscriptions SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
}

export async function setPastDueSince(db: D1Database, id: string, pastDueSince: string | null): Promise<void> {
  await db
    .prepare('UPDATE subscriptions SET past_due_since = ? WHERE id = ?')
    .bind(pastDueSince, id)
    .run();
}

export async function getStaleSuspendedConnections(db: D1Database, maxAgeDays: number): Promise<Connection[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT * FROM connections
       WHERE status = 'suspended'
         AND suspended_at IS NOT NULL
         AND suspended_at < ?`
    )
    .bind(cutoff)
    .all<Connection>();
  return result.results;
}

export async function deleteUserCascade(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM connections WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

export async function upsertSubscription(db: D1Database, subscription: Omit<Subscription, 'created_at' | 'past_due_since'> & { past_due_since?: string | null }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions (id, user_id, quantity, status, current_period_end)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         quantity = excluded.quantity,
         status = excluded.status,
         current_period_end = excluded.current_period_end`
    )
    .bind(
      subscription.id,
      subscription.user_id,
      subscription.quantity,
      subscription.status,
      subscription.current_period_end
    )
    .run();
}

export async function getActiveSubscription(db: D1Database, userId: string): Promise<Subscription | null> {
  return db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') LIMIT 1")
    .bind(userId)
    .first<Subscription>();
}

export async function getStaleConnections(
  db: D1Database,
  service: string,
  refreshIntervalMinutes: number
): Promise<Connection[]> {
  const result = await db
    .prepare(
      `SELECT * FROM connections
       WHERE key_storage_mode = 'managed'
         AND auth_type = 'oauth'
         AND status = 'active'
         AND service = ?
         AND (
           last_refreshed_at IS NULL
           OR last_refreshed_at < datetime('now', '-' || ? || ' minutes')
         )`
    )
    .bind(service, refreshIntervalMinutes)
    .all<Connection>();
  return result.results;
}

export async function updateConnectionLastRefreshed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE connections SET last_refreshed_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

const BATCH_CHUNK_SIZE = 50;

export async function getExistingConnectionIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const result = new Set<string>();

  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT id FROM connections WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) {
      result.add(row.id);
    }
  }

  return result;
}

export async function setNeedsReauthAt(db: D1Database, id: string, timestamp: string): Promise<void> {
  await db
    .prepare('UPDATE connections SET needs_reauth_at = ? WHERE id = ?')
    .bind(timestamp, id)
    .run();
}

export async function clearNeedsReauthAt(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE connections SET needs_reauth_at = NULL WHERE id = ?')
    .bind(id)
    .run();
}

export async function acquireRefreshLock(
  db: D1Database,
  connectionId: string,
  ttlSeconds: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO refresh_locks (connection_id, locked_at, expires_at)
       VALUES (?, datetime('now'), datetime('now', '+' || ? || ' seconds'))
       ON CONFLICT (connection_id) DO UPDATE
       SET locked_at = datetime('now'), expires_at = datetime('now', '+' || ? || ' seconds')
       WHERE expires_at < datetime('now')`
    )
    .bind(connectionId, ttlSeconds, ttlSeconds)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function cleanupExpiredRefreshLocks(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM refresh_locks WHERE expires_at < datetime('now')").run();
}
