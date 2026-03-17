import { getConnectionsByUserId, updateConnectionStatus, setSuspendedAt } from '../db/queries';
import { withProxyCache } from '../proxy/kv-cache';
import type { Env } from '../index';

export async function suspendExcessConnections(
  env: Env, userId: string, maxAllowed: number
): Promise<void> {
  const connections = await getConnectionsByUserId(env.DB, userId);
  const active = connections.filter(c => c.status === 'active' || c.status === 'unused');
  if (active.length <= maxAllowed) return;
  const sorted = active.sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const toSuspend = sorted.slice(maxAllowed);
  for (const conn of toSuspend) {
    await updateConnectionStatus(env.DB, conn.id, 'suspended');
    await setSuspendedAt(env.DB, conn.id, new Date().toISOString());
    await withProxyCache(env, conn.secret_url_segment_1, null, async (entry, write) => {
      entry.status = 'suspended';
      entry.cachedAt = new Date().toISOString();
      await write();
    });
  }
}

export async function reactivateSuspendedConnections(
  env: Env, userId: string, maxAllowed: number
): Promise<void> {
  const connections = await getConnectionsByUserId(env.DB, userId);
  const active = connections.filter(c => c.status === 'active' || c.status === 'unused');
  const suspended = connections.filter(c => c.status === 'suspended');

  const slotsAvailable = maxAllowed - active.length;
  if (slotsAvailable <= 0 || suspended.length === 0) return;

  // Reactivate oldest first (FIFO by created_at)
  const sorted = suspended.sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const toReactivate = sorted.slice(0, slotsAvailable);
  for (const conn of toReactivate) {
    await updateConnectionStatus(env.DB, conn.id, 'active');
    await setSuspendedAt(env.DB, conn.id, null);
    await withProxyCache(env, conn.secret_url_segment_1, null, async (entry, write) => {
      entry.status = 'active';
      entry.cachedAt = new Date().toISOString();
      await write();
    });
  }
}
