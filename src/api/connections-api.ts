import { getConnectionsByUserId, deleteConnection, updateConnectionLabel } from '../db/queries';
import type { Connection } from '@bindify/types';

const SERVICE_NAMES: Record<string, string> = {
  linear: 'Linear',
  todoist: 'Todoist',
  atlassian: 'Atlassian',
  notion: 'Notion',
  github: 'GitHub',
  figma: 'Figma',
};

export function generateDefaultLabel(service: string, index: number): string {
  return `${SERVICE_NAMES[service] || service} ${index}`;
}

export async function handleListConnections(
  db: D1Database,
  userId: string,
  baseUrl: string
): Promise<Response> {
  const connections = await getConnectionsByUserId(db, userId);

  // Zero-knowledge: secret_url and api_key are NOT returned (never stored)
  const mapped = connections.map((conn: Connection) => ({
    id: conn.id,
    service: conn.service,
    status: conn.status,
    auth_type: conn.auth_type,
    key_storage_mode: conn.key_storage_mode,
    application: conn.application,
    label: conn.label,
    last_used_at: conn.last_used_at,
    needs_reauth_at: conn.needs_reauth_at,
    created_at: conn.created_at,
  }));

  return Response.json({ connections: mapped });
}

export async function handleUpdateConnectionLabel(
  db: D1Database,
  connectionId: string,
  userId: string,
  label: string
): Promise<Response> {
  const connections = await getConnectionsByUserId(db, userId);
  const connection = connections.find((c: Connection) => c.id === connectionId);
  if (!connection) {
    return Response.json({ error: 'not_found', message: 'Connection not found' }, { status: 404 });
  }

  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 100) {
    return Response.json({ error: 'invalid_request', message: 'Label must be 1-100 characters' }, { status: 400 });
  }

  await updateConnectionLabel(db, connectionId, trimmed);
  return Response.json({ success: true, label: trimmed });
}

export async function handleDeleteConnection(
  db: D1Database,
  kv: KVNamespace,
  connectionId: string,
  userId: string
): Promise<Response> {
  // Verify ownership
  const connections = await getConnectionsByUserId(db, userId);
  const connection = connections.find((c: Connection) => c.id === connectionId);
  if (!connection) {
    return Response.json({ error: 'not_found', message: 'Connection not found' }, { status: 404 });
  }

  // Invalidate proxy cache: write a tombstone instead of deleting.
  // KV deletes are eventually consistent across Cloudflare edge locations and can take
  // up to 60s to propagate. A tombstone write propagates faster because KV prioritizes
  // writes over deletes. The proxy handler's schema version check will reject the tombstone
  // (schemaVersion 0 !== PROXY_CACHE_SCHEMA_VERSION) and return 404 immediately.
  await kv.put(`proxy:${connection.secret_url_segment_1}`, JSON.stringify({ schemaVersion: 0, deleted: true }), { expirationTtl: 300 });

  // Delete connection from D1
  await deleteConnection(db, connectionId);

  return Response.json({ success: true });
}
