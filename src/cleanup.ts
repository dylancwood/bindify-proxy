import { getStaleSuspendedConnections, deleteConnection } from './db/queries';

export async function cleanupStaleSuspendedConnections(
  db: D1Database,
  kv: KVNamespace,
  maxAgeDays: number
): Promise<number> {
  const stale = await getStaleSuspendedConnections(db, maxAgeDays);
  for (const conn of stale) {
    await kv.put(`proxy:${conn.secret_url_segment_1}`, JSON.stringify({ schemaVersion: 0, deleted: true }), { expirationTtl: 300 });
    await deleteConnection(db, conn.id);
  }
  return stale.length;
}
