import type { Connection, User } from '@bindify/types';
import type { Env } from '../index';
import type { ConnectionWithUserRow } from '../db/queries';
import { buildProxyCacheEntry, writeProxyCache, type ProxyCacheEntry } from './kv-cache';

export function rowToConnection(row: ConnectionWithUserRow): Connection {
  return {
    id: row.id,
    user_id: row.user_id,
    service: row.service as Connection['service'],
    secret_url_segment_1: row.secret_url_segment_1,
    status: row.status as Connection['status'],
    key_storage_mode: row.key_storage_mode,
    auth_type: row.auth_type,
    auth_mode: row.auth_mode,
    application: row.application,
    label: row.label,
    dcr_registration: row.dcr_registration,
    encrypted_tokens: row.encrypted_tokens,
    key_version: 0, // deprecated
    key_fingerprint: row.key_fingerprint, // keep — deprecated but still in Connection type
    managed_key_fingerprint: row.managed_key_fingerprint,
    dcr_key_fingerprint: row.dcr_key_fingerprint,
    needs_reauth_at: row.needs_reauth_at,
    last_used_at: row.last_used_at,
    last_refreshed_at: row.last_refreshed_at,
    suspended_at: row.suspended_at,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

export function rowToUser(row: ConnectionWithUserRow): User {
  return {
    id: row.user_id,
    stripe_customer_id: null,
    plan: row.plan as User['plan'],
    trial_ends_at: row.trial_ends_at,
    access_until: row.access_until,
    email: null,
    created_at: '',
  };
}

/**
 * Rebuild a KV proxy cache entry from a D1 connection+user+subscription row.
 * Used by both the consistency checker (cron) and the hot-path schema mismatch fallback.
 */
export async function rebuildKvEntryFromRow(
  env: Env,
  secret1: string,
  row: ConnectionWithUserRow,
): Promise<ProxyCacheEntry> {
  const connection = rowToConnection(row);
  const user = rowToUser(row);
  const entry = buildProxyCacheEntry(
    connection,
    user,
    row.subscription_status,
    row.subscription_past_due_since,
    row.encrypted_tokens ?? '',
  );
  await writeProxyCache(env, secret1, entry);
  return entry;
}
