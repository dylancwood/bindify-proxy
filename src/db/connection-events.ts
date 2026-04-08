import { resolveEventCategory } from '../services/expected-errors';

export interface ConnectionEvent {
  connectionId: string | null;
  userId?: string;
  eventType: string;
  category: string;
  detail?: string;
  upstreamStatus?: number;
  encryptedPayload?: string;
}

export interface ConnectionEventRow {
  id: string;
  connectionId: string | null;
  userId: string | null;
  eventType: string;
  category: string;
  detail: string | null;
  upstreamStatus: number | null;
  encryptedPayload: string | null;
  createdAt: string;
}

// Raw D1 row shape (snake_case column names)
interface D1EventRow {
  id: string;
  connection_id: string | null;
  user_id: string | null;
  event_type: string;
  category: string;
  detail: string | null;
  upstream_status: number | null;
  encrypted_payload: string | null;
  created_at: string;
}

const MAX_EVENTS_PER_CONNECTION = 200;
const MAX_ORPHAN_EVENTS = 20_000;
const DEDUP_FAILURE_WINDOW_SECONDS = 60 * 60; // 1 hour
const DEDUP_PROXY_SUCCESS_WINDOW_SECONDS = 5 * 60; // 5 minutes

function mapRow(row: D1EventRow): ConnectionEventRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    userId: row.user_id,
    eventType: row.event_type,
    category: row.category,
    detail: row.detail,
    upstreamStatus: row.upstream_status,
    encryptedPayload: row.encrypted_payload,
    createdAt: row.created_at,
  };
}

async function checkDedup(db: D1Database, event: ConnectionEvent): Promise<boolean> {
  const { connectionId, eventType, category, detail, upstreamStatus } = event;

  // Orphan events (no connection) — always write
  if (!connectionId) return true;

  // token_refresh/success — always write
  if ((eventType === 'token_refresh' || eventType === 'keepalive') && category === 'success') return true;

  // connection_created, reauth — always write
  if (eventType === 'connection_created' || eventType === 'reauth') return true;

  // d1_write_failed — always write (recovery tokens must never be deduped)
  if (category === 'd1_write_failed') return true;

  // auth/success — only write if previous auth event was a failure (recovery)
  if (eventType === 'auth' && category === 'success') {
    const prev = await db
      .prepare(
        `SELECT category FROM connection_events WHERE connection_id = ? AND event_type = 'auth' ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .bind(connectionId)
      .first<{ category: string }>();
    return prev !== null && prev.category !== 'success';
  }

  // proxy_request/success — deduplicate within 5 minutes
  if (eventType === 'proxy_request' && category === 'success') {
    const recent = await db
      .prepare(
        `SELECT id FROM connection_events WHERE connection_id = ? AND event_type = 'proxy_request' AND category = 'success' AND created_at >= datetime('now', '-' || ? || ' seconds') LIMIT 1`
      )
      .bind(connectionId, DEDUP_PROXY_SUCCESS_WINDOW_SECONDS)
      .first();
    return recent === null;
  }

  // proxy_request/upstream_error — deduplicate by upstream_status within 1 hour
  if (eventType === 'proxy_request' && category === 'upstream_error') {
    const recent = await db
      .prepare(
        `SELECT id FROM connection_events WHERE connection_id = ? AND event_type = 'proxy_request' AND category = 'upstream_error' AND upstream_status IS ? AND created_at >= datetime('now', '-' || ? || ' seconds') LIMIT 1`
      )
      .bind(connectionId, upstreamStatus ?? null, DEDUP_FAILURE_WINDOW_SECONDS)
      .first();
    return recent === null;
  }

  // token_refresh and auth failures — deduplicate by event_type+category+detail within 1 hour
  const recent = await db
    .prepare(
      `SELECT id FROM connection_events WHERE connection_id = ? AND event_type = ? AND category = ? AND (detail IS ? OR (detail IS NULL AND ? IS NULL)) AND created_at >= datetime('now', '-' || ? || ' seconds') LIMIT 1`
    )
    .bind(connectionId, eventType, category, detail ?? null, detail ?? null, DEDUP_FAILURE_WINDOW_SECONDS)
    .first();
  return recent === null;
}

export async function writeConnectionEvent(db: D1Database, event: ConnectionEvent, service?: string): Promise<void> {
  const resolvedEvent = service
    ? { ...event, category: resolveEventCategory(event, service) }
    : event;

  const shouldWrite = await checkDedup(db, resolvedEvent);
  if (!shouldWrite) return;

  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO connection_events (id, connection_id, user_id, event_type, category, detail, upstream_status, encrypted_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      resolvedEvent.connectionId ?? null,
      resolvedEvent.userId ?? null,
      resolvedEvent.eventType,
      resolvedEvent.category,
      resolvedEvent.detail ?? null,
      resolvedEvent.upstreamStatus ?? null,
      resolvedEvent.encryptedPayload ?? null
    )
    .run();

  if (event.connectionId) {
    // Prune old events beyond the per-connection cap
    await db
      .prepare(
        `DELETE FROM connection_events
         WHERE connection_id = ?
           AND id NOT IN (
             SELECT id FROM connection_events
             WHERE connection_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`
      )
      .bind(event.connectionId, event.connectionId, MAX_EVENTS_PER_CONNECTION)
      .run();
  } else {
    // Prune orphan events (NULL connection_id) beyond the global cap
    await db
      .prepare(
        `DELETE FROM connection_events
         WHERE connection_id IS NULL
           AND id NOT IN (
             SELECT id FROM connection_events
             WHERE connection_id IS NULL
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`
      )
      .bind(MAX_ORPHAN_EVENTS)
      .run();
  }
}

export async function getConnectionEvents(
  db: D1Database,
  connectionId: string,
  limit = -1
): Promise<ConnectionEventRow[]> {
  const result = await db
    .prepare(
      'SELECT * FROM connection_events WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
    .bind(connectionId, limit)
    .all<D1EventRow>();

  return result.results.map(mapRow);
}
