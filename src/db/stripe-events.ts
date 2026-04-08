interface StripeEventRow {
  id: string;
  type: string;
  stripe_customer_id: string | null;
  user_id: string | null;
  data: string;
  created_at: string;
}

interface StripeEventInput {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export async function logStripeEvent(db: D1Database, event: StripeEventInput): Promise<void> {
  const stripeCustomerId = (event.data.object.customer as string) ?? null;

  let userId: string | null = null;
  if (stripeCustomerId) {
    const user = await db
      .prepare('SELECT id FROM users WHERE stripe_customer_id = ?')
      .bind(stripeCustomerId)
      .first<{ id: string }>();
    userId = user?.id ?? null;
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO stripe_events (id, type, stripe_customer_id, user_id, data)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(event.id, event.type, stripeCustomerId, userId, JSON.stringify(event))
    .run();
}

export async function getStripeEvent(db: D1Database, eventId: string): Promise<StripeEventRow | null> {
  return db
    .prepare('SELECT * FROM stripe_events WHERE id = ?')
    .bind(eventId)
    .first<StripeEventRow>();
}

export async function deleteExpiredStripeEvents(db: D1Database, retentionDays: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM stripe_events WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .bind(retentionDays)
    .run();
  return result.meta.changes ?? 0;
}
