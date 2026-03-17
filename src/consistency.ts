import type { Env } from './index';
import type { Connection, User } from '../../../shared/types';
import { buildProxyCacheEntry, writeProxyCache, PROXY_CACHE_SCHEMA_VERSION, type ProxyCacheEntry } from './proxy/kv-cache';
import { insertAnomalyReport, hasUnacknowledgedAnomaly } from './db/anomaly-reports';
import { REFRESH_CONFIG } from './services/refresh-config';
import { log } from './logger';

export interface ConsistencyCheckResult {
  checked: number;
  rectified: number;
  unrectifiable: number;
}

interface ConnectionRow {
  // Connection fields
  id: string;
  user_id: string;
  service: string;
  secret_url_segment_1: string;
  status: string;
  key_storage_mode: 'managed' | 'zero_knowledge';
  auth_type: 'oauth' | 'api_key';
  auth_mode: string | null;
  application: string | null;
  label: string | null;
  dcr_registration: string | null;
  encrypted_tokens: string | null;
  key_version: number;
  needs_reauth_at: string | null;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  suspended_at: string | null;
  created_at: string;
  // User fields (from JOIN)
  plan: string;
  trial_ends_at: string | null;
  access_until: string | null;
  // Subscription fields (from JOIN)
  subscription_status: string | null;
  subscription_past_due_since: string | null;
}

/** Fields to compare between KV cache and D1. */
const COMPARISON_FIELDS: Array<{
  kvField: string;
  kvPath?: string[];
  d1Field: keyof ConnectionRow;
}> = [
  { kvField: 'connectionId', d1Field: 'id' },
  { kvField: 'status', d1Field: 'status' },
  { kvField: 'keyVersion', d1Field: 'key_version' },
  { kvField: 'userId', d1Field: 'user_id' },
  { kvField: 'service', d1Field: 'service' },
  { kvField: 'authType', d1Field: 'auth_type' },
  { kvField: 'authMode', d1Field: 'auth_mode' },
  { kvField: 'application', d1Field: 'application' },
  { kvField: 'keyStorageMode', d1Field: 'key_storage_mode' },
  { kvField: 'needsReauthAt', d1Field: 'needs_reauth_at' },
  { kvField: 'user.plan', kvPath: ['user', 'plan'], d1Field: 'plan' },
  { kvField: 'user.trialEndsAt', kvPath: ['user', 'trialEndsAt'], d1Field: 'trial_ends_at' },
  { kvField: 'user.accessUntil', kvPath: ['user', 'accessUntil'], d1Field: 'access_until' },
  { kvField: 'subscriptionStatus', d1Field: 'subscription_status' },
  { kvField: 'subscriptionPastDueSince', d1Field: 'subscription_past_due_since' },
];

function getKvValue(entry: ProxyCacheEntry, field: typeof COMPARISON_FIELDS[number]): unknown {
  if (field.kvPath) {
    let val: any = entry;
    for (const key of field.kvPath) {
      val = val?.[key];
    }
    return val ?? null;
  }
  return (entry as any)[field.kvField] ?? null;
}

function rowToConnection(row: ConnectionRow): Connection {
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
    key_version: row.key_version,
    needs_reauth_at: row.needs_reauth_at,
    last_used_at: row.last_used_at,
    last_refreshed_at: row.last_refreshed_at,
    suspended_at: row.suspended_at,
    created_at: row.created_at,
  };
}

function rowToUser(row: ConnectionRow): User {
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

function isKvMismatch(entry: ProxyCacheEntry, row: ConnectionRow): boolean {
  for (const field of COMPARISON_FIELDS) {
    const kvVal = getKvValue(entry, field);
    const d1Val = row[field.d1Field] ?? null;
    if (kvVal !== d1Val) return true;
  }
  return false;
}

async function reportAnomaly(
  db: D1Database,
  connectionId: string,
  anomalyType: string,
  rectified: boolean,
  detail: string,
): Promise<void> {
  const exists = await hasUnacknowledgedAnomaly(db, connectionId, anomalyType);
  if (exists) return;
  await insertAnomalyReport(db, { connectionId, anomalyType, rectified, detail });
}

export async function checkKvD1Consistency(env: Env): Promise<ConsistencyCheckResult> {
  const result: ConsistencyCheckResult = { checked: 0, rectified: 0, unrectifiable: 0 };

  // Query all active/suspended connections with user and subscription data
  const query = `
    SELECT c.*, u.plan, u.trial_ends_at, u.access_until,
           s.status AS subscription_status, s.past_due_since AS subscription_past_due_since
    FROM connections c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN subscriptions s ON c.user_id = s.user_id
      AND s.id = (SELECT id FROM subscriptions WHERE user_id = c.user_id ORDER BY created_at DESC LIMIT 1)
    WHERE c.status IN ('active', 'suspended')
  `;

  const rows = await env.DB.prepare(query).all<ConnectionRow>();
  const connections = rows.results;
  result.checked = connections.length;

  // Check D1-only anomalies for all connections
  for (const row of connections) {
    try {
      // Corrupted tokens: managed connection with null/empty encrypted_tokens
      if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
        await reportAnomaly(env.DB, row.id, 'corrupted_tokens', false, 'Managed connection has null or empty encrypted_tokens');
        result.unrectifiable++;
      }

      // Stale managed refresh: managed oauth, last_refreshed_at > 4x refresh interval
      if (row.key_storage_mode === 'managed' && row.auth_type === 'oauth' && row.status === 'active' && row.last_refreshed_at) {
        const serviceConfig = REFRESH_CONFIG[row.service];
        if (serviceConfig) {
          const staleThresholdMinutes = serviceConfig.refreshIntervalMinutes * 4;
          const lastRefreshed = new Date(row.last_refreshed_at).getTime();
          const elapsed = Date.now() - lastRefreshed;
          const staleThresholdMs = staleThresholdMinutes * 60 * 1000;
          if (elapsed > staleThresholdMs) {
            await reportAnomaly(
              env.DB,
              row.id,
              'stale_managed_refresh',
              false,
              `Last refreshed ${Math.round(elapsed / (60 * 1000))} minutes ago (threshold: ${staleThresholdMinutes} min)`,
            );
            result.unrectifiable++;
          }
        }
      }
    } catch (err) {
      log.error('Consistency check failed for connection (D1 check)', { connectionId: row.id, error: String(err) });
    }
  }

  // For active connections: batch KV lookups (25 at a time)
  const activeConnections = connections.filter((c) => c.status === 'active');

  for (let i = 0; i < activeConnections.length; i += 25) {
    const batch = activeConnections.slice(i, i + 25);
    const kvResults = await Promise.all(
      batch.map(async (row) => {
        const kvKey = `proxy:${row.secret_url_segment_1}`;
        const raw = await env.KV.get(kvKey);
        return { row, raw };
      }),
    );

    for (const { row, raw } of kvResults) {
      try {
      if (!raw) {
        // Missing KV cache — rebuild if we have tokens (or if zero_knowledge, we still rebuild)
        if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
          // Can't rebuild without tokens — already reported as corrupted_tokens above
          continue;
        }
        const connection = rowToConnection(row);
        const user = rowToUser(row);
        const entry = buildProxyCacheEntry(
          connection,
          user,
          row.subscription_status,
          row.subscription_past_due_since,
          row.encrypted_tokens ?? '',
        );
        await writeProxyCache(env, row.secret_url_segment_1, entry);
        await reportAnomaly(env.DB, row.id, 'missing_kv_cache', true, 'KV cache was missing, rebuilt from D1');
        result.rectified++;
        continue;
      }

      let entry: ProxyCacheEntry;
      try {
        entry = JSON.parse(raw);
      } catch {
        // Corrupted KV — rebuild
        const connection = rowToConnection(row);
        const user = rowToUser(row);
        const rebuilt = buildProxyCacheEntry(
          connection,
          user,
          row.subscription_status,
          row.subscription_past_due_since,
          row.encrypted_tokens ?? '',
        );
        await writeProxyCache(env, row.secret_url_segment_1, rebuilt);
        await reportAnomaly(env.DB, row.id, 'stale_kv_data', true, 'KV cache was corrupted, rebuilt from D1');
        result.rectified++;
        continue;
      }

      // Tombstone for active connection
      if (entry.schemaVersion === 0) {
        if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
          continue;
        }
        const connection = rowToConnection(row);
        const user = rowToUser(row);
        const rebuilt = buildProxyCacheEntry(
          connection,
          user,
          row.subscription_status,
          row.subscription_past_due_since,
          row.encrypted_tokens ?? '',
        );
        await writeProxyCache(env, row.secret_url_segment_1, rebuilt);
        await reportAnomaly(env.DB, row.id, 'stale_kv_data', true, 'KV had tombstone for active connection, rebuilt from D1');
        result.rectified++;
        continue;
      }

      // Stale/mismatched KV
      if (isKvMismatch(entry, row)) {
        if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
          continue;
        }
        const connection = rowToConnection(row);
        const user = rowToUser(row);
        const rebuilt = buildProxyCacheEntry(
          connection,
          user,
          row.subscription_status,
          row.subscription_past_due_since,
          row.encrypted_tokens ?? '',
        );
        await writeProxyCache(env, row.secret_url_segment_1, rebuilt);
        await reportAnomaly(env.DB, row.id, 'stale_kv_data', true, 'KV cache was stale, rebuilt from D1');
        result.rectified++;
      }
      } catch (err) {
        log.error('Consistency check failed for connection (KV check)', { connectionId: row.id, error: String(err) });
      }
    }
  }

  return result;
}
