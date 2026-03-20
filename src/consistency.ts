import type { Env } from './index';
import { PROXY_CACHE_SCHEMA_VERSION, type ProxyCacheEntry } from './proxy/kv-cache';
import { rebuildKvEntryFromRow } from './proxy/kv-rebuild';
import type { ConnectionWithUserRow } from './db/queries';
import { insertAnomalyReport, hasUnacknowledgedAnomaly } from './db/anomaly-reports';
import { REFRESH_CONFIG } from './services/refresh-config';
import { log } from './logger';

export interface ConsistencyCheckResult {
  checked: number;
  rectified: number;
  unrectifiable: number;
}

/** Fields to compare between KV cache and D1. */
const COMPARISON_FIELDS: Array<{
  kvField: string;
  kvPath?: string[];
  d1Field: keyof ConnectionWithUserRow;
}> = [
  { kvField: 'connectionId', d1Field: 'id' },
  { kvField: 'status', d1Field: 'status' },
  { kvField: 'keyFingerprint', d1Field: 'key_fingerprint' },
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

function isKvMismatch(entry: ProxyCacheEntry, row: ConnectionWithUserRow): boolean {
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
  // CTE computes the latest subscription per user once, then joins — O(n+m) instead of O(n*m)
  const query = `
    WITH latest_subs AS (
      SELECT s1.user_id, s1.id, s1.status, s1.past_due_since
      FROM subscriptions s1
      WHERE s1.created_at = (
        SELECT MAX(s2.created_at) FROM subscriptions s2 WHERE s2.user_id = s1.user_id
      )
    )
    SELECT c.*, u.plan, u.trial_ends_at, u.access_until,
           s.status AS subscription_status, s.past_due_since AS subscription_past_due_since
    FROM connections c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN latest_subs s ON c.user_id = s.user_id
    WHERE c.status IN ('active', 'suspended')
  `;

  const rows = await env.DB.prepare(query).all<ConnectionWithUserRow>();
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
        await rebuildKvEntryFromRow(env, row.secret_url_segment_1, row);
        await reportAnomaly(env.DB, row.id, 'missing_kv_cache', true, 'KV cache was missing, rebuilt from D1');
        result.rectified++;
        continue;
      }

      let entry: ProxyCacheEntry;
      try {
        entry = JSON.parse(raw);
      } catch {
        // Corrupted KV — rebuild
        await rebuildKvEntryFromRow(env, row.secret_url_segment_1, row);
        await reportAnomaly(env.DB, row.id, 'stale_kv_data', true, 'KV cache was corrupted, rebuilt from D1');
        result.rectified++;
        continue;
      }

      // Tombstone for active connection
      if (entry.schemaVersion === 0) {
        if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
          continue;
        }
        await rebuildKvEntryFromRow(env, row.secret_url_segment_1, row);
        await reportAnomaly(env.DB, row.id, 'stale_kv_data', true, 'KV had tombstone for active connection, rebuilt from D1');
        result.rectified++;
        continue;
      }

      // Stale/mismatched KV
      if (isKvMismatch(entry, row)) {
        if (row.key_storage_mode === 'managed' && (!row.encrypted_tokens || row.encrypted_tokens === '')) {
          continue;
        }
        await rebuildKvEntryFromRow(env, row.secret_url_segment_1, row);
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
