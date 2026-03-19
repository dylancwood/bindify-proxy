import type { Env } from './index';
import type { Connection, TokenData } from '@bindify/types';
import { getStaleConnections, updateConnectionLastRefreshed, updateConnectionStatus, setNeedsReauthAt, clearNeedsReauthAt, cleanupExpiredRefreshLocks } from './db/queries';
import { deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey, getManagedKey, getActiveKey, PERMANENT_TOKEN_EXPIRY_SECONDS } from './crypto';
import { getManagedEncryptionKeys } from './index';
import { getService } from './services/registry';
import { getDCRClientId, checkDCRRegistrationDirect } from './services/dcr';
import type { DCRRegistration } from './services/dcr';
import { getCallbackUrl } from './utils/url';
import { REFRESH_CONFIG } from './services/refresh-config';
import { log } from './logger';
import { parseTokenResponseBody, validateTokenData, validateDecryptedTokens } from './token-parsing';
import { validateTokensBeforeWrite } from './token-validation';
import { writeConnectionEvent } from './db/connection-events';
import { fetchMcpToolsList } from './api/validate-application';
import { withProxyCache } from './proxy/kv-cache';

const LOCK_KEY = 'cron:refresh:lock';
const LOCK_TTL_S = 3600;
const BATCH_SIZE = 25;

// Note: This lock is not atomic — there's a race window between the get() and put().
// Cloudflare KV doesn't offer compare-and-swap. In practice, the 6-hour cron interval
// makes concurrent invocations extremely unlikely. Worst case: duplicate refreshes
// (idempotent for most providers, but providers with rotating refresh tokens could be
// affected). A D1-based lock with INSERT OR IGNORE would provide true atomicity if needed.
export async function acquireLock(kv: KVNamespace): Promise<boolean> {
  const existing = await kv.get(LOCK_KEY);
  if (existing) return false;
  await kv.put(LOCK_KEY, Date.now().toString(), { expirationTtl: LOCK_TTL_S });
  return true;
}

export async function releaseLock(kv: KVNamespace): Promise<void> {
  await kv.delete(LOCK_KEY);
}

export async function refreshManagedConnection(connection: Connection, env: Env): Promise<boolean> {
  const serviceDef = getService(connection.service);
  if (!serviceDef) {
    log.error('Unknown service for refresh', undefined, { connectionId: connection.id, service: connection.service });
    return false;
  }

  try {
    if (connection.key_storage_mode !== 'managed') {
      throw new Error(
        `refreshManagedConnection called with key_storage_mode=${connection.key_storage_mode}, connectionId=${connection.id}`
      );
    }
    const keys = await getManagedEncryptionKeys(env);
    const masterKeyStr = getManagedKey(keys, connection.key_fingerprint);
    const encryptionKey = await deriveManagedEncryptionKey(masterKeyStr, connection.id);
    if (!connection.encrypted_tokens) {
      log.error('Missing encrypted_tokens for refresh', undefined, { connectionId: connection.id });
      return false;
    }

    const decrypted = await decryptTokenDataWithKey(connection.encrypted_tokens, encryptionKey);
    const tokens = JSON.parse(decrypted) as TokenData;
    validateDecryptedTokens(tokens, 'oauth');

    if (!serviceDef.config.tokenUrl || (!serviceDef.config.clientIdEnvKey && !serviceDef.config.useDCR)) {
      log.error('Service does not support OAuth refresh', undefined, { connectionId: connection.id });
      return false;
    }

    if (!tokens.refresh_token) {
      log.info('Skipping refresh — no refresh_token (non-expiring token)', { connectionId: connection.id });
      return true;
    }

    let clientId: string;
    if (serviceDef.config.useDCR) {
      if (connection.dcr_registration) {
        const dcrKey = await deriveManagedEncryptionKey(masterKeyStr, connection.id);
        const decryptedDcr = await decryptTokenDataWithKey(connection.dcr_registration, dcrKey);
        const reg = JSON.parse(decryptedDcr) as DCRRegistration;
        clientId = reg.client_id;
      } else {
        const callbackUrl = getCallbackUrl(env);
        clientId = await getDCRClientId(serviceDef.config, env.KV, callbackUrl);
      }
    } else {
      clientId = (env as any)[serviceDef.config.clientIdEnvKey!];
    }
    const clientSecret = serviceDef.config.clientSecretEnvKey ? (env as any)[serviceDef.config.clientSecretEnvKey] : undefined;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }

    const response = await fetch(serviceDef.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      const responseData = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const errorType = responseData?.error;
      const isInvalidGrant = errorType === 'invalid_grant';
      const isInvalidClient = errorType === 'invalid_client';

      if (isInvalidGrant || isInvalidClient) {
        // Soft flag — don't hard-block the connection
        log.error('Refresh token may be revoked, flagging needs_reauth', undefined, {
          connectionId: connection.id,
          errorType,
          status: response.status,
        });
        const reauthNow = new Date().toISOString();
        await setNeedsReauthAt(env.DB, connection.id, reauthNow);
        await withProxyCache(env, connection.secret_url_segment_1, null, async (entry, write) => {
          entry.needsReauthAt = reauthNow;
          await write();
        });
      } else {
        log.error('Transient refresh failure', undefined, { connectionId: connection.id, status: response.status });
      }
      if (isInvalidGrant || isInvalidClient) {
        await writeConnectionEvent(env.DB, {
          connectionId: connection.id,
          eventType: 'token_refresh',
          category: 'invalid_grant',
          detail: `Cron refresh: ${errorType}`,
          upstreamStatus: response.status,
        }).catch(() => {});
      } else {
        await writeConnectionEvent(env.DB, {
          connectionId: connection.id,
          eventType: 'token_refresh',
          category: 'refresh_failed',
          detail: `Cron refresh failed: ${response.status}`,
          upstreamStatus: response.status,
        }).catch(() => {});
      }
      return false;
    }

    const rawBody = await response.text();
    const contentType = response.headers.get('content-type');
    const data = parseTokenResponseBody(rawBody, contentType);
    const requiresRefresh = serviceDef.config.requiresRefresh !== false;
    const rawValidation = validateTokenData(data, requiresRefresh);
    if (!rawValidation.valid) {
      log.error('Cron refresh token validation failed', undefined, {
        connectionId: connection.id,
        error: rawValidation.error,
      });
      await writeConnectionEvent(env.DB, {
        connectionId: connection.id,
        eventType: 'token_refresh',
        category: 'refresh_failed',
        detail: `Cron refresh validation: ${rawValidation.error}`,
      }).catch(() => {});
      return false;
    }
    const updated: TokenData = serviceDef.overrides?.parseTokenResponse
      ? serviceDef.overrides.parseTokenResponse(data)
      : {
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? tokens.refresh_token,
          expires_at: data.expires_in
            ? Math.floor(Date.now() / 1000) + data.expires_in
            : Math.floor(Date.now() / 1000) + PERMANENT_TOKEN_EXPIRY_SECONDS,
        };

    const preWriteValidation = validateTokensBeforeWrite(tokens, updated);
    if (!preWriteValidation.valid) {
      log.error('Cron refresh pre-write validation failed', undefined, {
        connectionId: connection.id,
        error: preWriteValidation.error,
      });
      await writeConnectionEvent(env.DB, {
        connectionId: connection.id,
        eventType: 'token_refresh',
        category: 'refresh_failed',
        detail: `Cron pre-write validation: ${preWriteValidation.error}`,
      }).catch(() => {});
      return false;
    }

    const active = getActiveKey(keys);
    const activeEncKey = await deriveManagedEncryptionKey(active.key, connection.id);
    const encrypted = await encryptTokenDataWithKey(JSON.stringify(updated), activeEncKey);

    // Write via proxy cache so the proxy path sees fresh tokens
    await withProxyCache(env, connection.secret_url_segment_1, null, async (entry, write) => {
      entry.encryptedTokens = encrypted;
      entry.keyFingerprint = active.fingerprint;
      await write({ isTokenUpdate: true });
    });

    await updateConnectionLastRefreshed(env.DB, connection.id);

    // Successful refresh proves the client_id works — clear any stale needs_reauth_at
    if (connection.needs_reauth_at) {
      await clearNeedsReauthAt(env.DB, connection.id);
      await withProxyCache(env, connection.secret_url_segment_1, null, async (entry, write) => {
        entry.needsReauthAt = null;
        await write();
      });
    }

    log.info('Token refreshed', { connectionId: connection.id, service: connection.service });
    await writeConnectionEvent(env.DB, {
      connectionId: connection.id,
      eventType: 'token_refresh',
      category: 'success',
      detail: `Cron refresh for ${connection.service}`,
    }).catch(() => {});
    return true;
  } catch (err) {
    log.error('Refresh error', err instanceof Error ? err : undefined, { connectionId: connection.id });
    await writeConnectionEvent(env.DB, {
      connectionId: connection.id,
      eventType: 'token_refresh',
      category: 'unknown',
      detail: `Cron refresh error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return false;
  }
}

// Keep-alive for managed connections on services where tokens don't expire (requiresRefresh === false).
// Asserts key_storage_mode === 'managed' (also filtered by getStaleConnections query).
// Uses fetchMcpToolsList (initialize + tools/list two-step handshake) to verify the token is still valid.
export async function keepaliveManagedConnection(connection: Connection, env: Env): Promise<boolean> {
  const serviceDef = getService(connection.service);
  if (!serviceDef) {
    log.error('Unknown service for keepalive', undefined, { connectionId: connection.id, service: connection.service });
    return false;
  }

  const mcpBaseUrl = serviceDef.config.mcpBaseUrl;
  if (!mcpBaseUrl) {
    log.error('No mcpBaseUrl for keepalive', undefined, { connectionId: connection.id, service: connection.service });
    return false;
  }

  try {
    if (connection.key_storage_mode !== 'managed') {
      throw new Error(
        `keepaliveManagedConnection called with key_storage_mode=${connection.key_storage_mode}, connectionId=${connection.id}`
      );
    }
    const keys = await getManagedEncryptionKeys(env);
    const masterKeyStr = getManagedKey(keys, connection.key_fingerprint);
    const encryptionKey = await deriveManagedEncryptionKey(masterKeyStr, connection.id);
    if (!connection.encrypted_tokens) {
      log.error('Missing encrypted_tokens for keepalive', undefined, { connectionId: connection.id });
      return false;
    }

    const decrypted = await decryptTokenDataWithKey(connection.encrypted_tokens, encryptionKey);
    const tokens = JSON.parse(decrypted) as TokenData;
    validateDecryptedTokens(tokens, 'oauth');

    const inject = serviceDef.config.apiKey?.inject;
    const prefix = inject?.type === 'header' ? (inject.prefix ?? '') : 'Bearer ';
    const authHeader = `${prefix}${tokens.access_token}`;

    const { tools } = await fetchMcpToolsList(mcpBaseUrl, authHeader);

    // Success — update last_refreshed_at and clear any reauth flag
    await updateConnectionLastRefreshed(env.DB, connection.id);
    await clearNeedsReauthAt(env.DB, connection.id);

    // Clear needsReauthAt in proxy cache too
    await withProxyCache(env, connection.secret_url_segment_1, null, async (entry, write) => {
      entry.needsReauthAt = null;
      await write();
    });

    log.info('Keep-alive succeeded', { connectionId: connection.id, service: connection.service, toolCount: tools.length });
    await writeConnectionEvent(env.DB, {
      connectionId: connection.id,
      eventType: 'keepalive',
      category: 'success',
      detail: `Keep-alive for ${connection.service}: ${tools.length} tools`,
    }).catch(() => {});
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Assertion error: called with wrong key_storage_mode — treat as unknown/unexpected
    if (message.includes('keepaliveManagedConnection called with key_storage_mode=')) {
      log.error('Keep-alive error', err instanceof Error ? err : undefined, { connectionId: connection.id });
      await writeConnectionEvent(env.DB, {
        connectionId: connection.id,
        eventType: 'keepalive',
        category: 'unknown',
        detail: `Keep-alive error: ${message}`,
      }).catch(() => {});
      return false;
    }

    // Parse HTTP status from fetchMcpToolsList error messages
    // (e.g. "MCP initialize failed: 401", "MCP tools/list failed: 500")
    // NOTE: This depends on the error message format in fetchMcpToolsList.
    // If that format changes, this parsing will need to be updated.
    const statusMatch = message.match(/failed: (\d+)/);
    const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    const isAuthFailure = upstreamStatus === 401 || upstreamStatus === 403;

    if (isAuthFailure) {
      log.error('Keep-alive auth failure, flagging needs_reauth', undefined, {
        connectionId: connection.id,
        service: connection.service,
        status: upstreamStatus,
      });
      const reauthNow = new Date().toISOString();
      await setNeedsReauthAt(env.DB, connection.id, reauthNow);
      await withProxyCache(env, connection.secret_url_segment_1, null, async (entry, write) => {
        entry.needsReauthAt = reauthNow;
        await write();
      });
      await writeConnectionEvent(env.DB, {
        connectionId: connection.id,
        eventType: 'keepalive',
        category: 'auth_failed',
        detail: `Keep-alive auth failure: ${message}`,
        upstreamStatus,
      }).catch(() => {});
    } else {
      log.error('Keep-alive transient failure', undefined, {
        connectionId: connection.id,
        service: connection.service,
        error: message,
      });
      await writeConnectionEvent(env.DB, {
        connectionId: connection.id,
        eventType: 'keepalive',
        category: 'transient_error',
        detail: `Keep-alive error: ${message}`,
        upstreamStatus,
      }).catch(() => {});
    }
    return false;
  }
}

// Buffer (in minutes) subtracted from each refresh interval to avoid race conditions
// where the cron fires slightly before the exact interval has elapsed.
const STALENESS_BUFFER_MINUTES = 60;

export async function refreshStaleConnections(env: Env): Promise<number> {
  let totalRefreshed = 0;
  for (const [serviceId, config] of Object.entries(REFRESH_CONFIG)) {
    const serviceDef = getService(serviceId);
    if (!serviceDef) continue;

    const effectiveInterval = config.refreshIntervalMinutes - STALENESS_BUFFER_MINUTES;
    const stale = await getStaleConnections(env.DB, serviceId, effectiveInterval);
    if (stale.length === 0) continue;
    log.info('Processing stale connections', { service: serviceId, count: stale.length });

    const isKeepalive = serviceDef.config.requiresRefresh === false;
    const handler = isKeepalive ? keepaliveManagedConnection : refreshManagedConnection;

    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const batch = stale.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(conn => handler(conn, env)));
      totalRefreshed += results.filter(Boolean).length;
    }
  }
  return totalRefreshed;
}

export async function keepaliveDCRRegistrations(env: Env): Promise<void> {
  for (const [serviceId] of Object.entries(REFRESH_CONFIG)) {
    const serviceDef = getService(serviceId);
    if (!serviceDef?.config.useDCR) continue;

    // Fetch all active connections with DCR registration
    const dcrConnections = await env.DB
      .prepare(`
        SELECT id, dcr_registration, secret_url_segment_1, key_fingerprint FROM connections
        WHERE service = ? AND status = 'active' AND dcr_registration IS NOT NULL
      `)
      .bind(serviceId)
      .all<{ id: string; dcr_registration: string; secret_url_segment_1: string; key_fingerprint: string }>();

    // Decrypt and group by client_id
    const byClientId = new Map<string, { reg: DCRRegistration; connections: typeof dcrConnections.results }>();
    for (const row of dcrConnections.results) {
      const keys = await getManagedEncryptionKeys(env);
      const masterKeyStr = getManagedKey(keys, row.key_fingerprint);
      const key = await deriveManagedEncryptionKey(masterKeyStr, row.id);
      const decrypted = await decryptTokenDataWithKey(row.dcr_registration, key);
      const reg = JSON.parse(decrypted) as DCRRegistration;
      const existing = byClientId.get(reg.client_id);
      if (existing) {
        existing.connections.push(row);
      } else {
        byClientId.set(reg.client_id, { reg, connections: [row] });
      }
    }

    // Check each registration
    for (const [clientId, { reg, connections }] of byClientId) {
      const alive = await checkDCRRegistrationDirect(reg, serviceDef.config);

      if (!alive) {
        log.error('DCR registration dead, flagging connections', undefined, {
          serviceId,
          clientId,
        });

        const now = new Date().toISOString();
        for (const conn of connections) {
          await setNeedsReauthAt(env.DB, conn.id, now);
          await withProxyCache(env, conn.secret_url_segment_1, null, async (entry, write) => {
            entry.needsReauthAt = now;
            await write();
          });
          await writeConnectionEvent(env.DB, {
            connectionId: conn.id,
            eventType: 'keepalive',
            category: 'dcr_dead',
            detail: `DCR registration dead for client ${clientId}`,
          }).catch(() => {});
        }
      } else {
        log.info('DCR registration alive', { serviceId, clientId });
      }
    }
  }
}

export async function handleScheduledRefresh(env: Env): Promise<void> {
  const acquired = await acquireLock(env.KV);
  if (!acquired) {
    log.info('Cron lock held — skipping refresh run');
    return;
  }
  try {
    await keepaliveDCRRegistrations(env);
    const count = await refreshStaleConnections(env);
    await cleanupExpiredRefreshLocks(env.DB);
    log.info('Cron refresh completed', { refreshedCount: count });
  } finally {
    await releaseLock(env.KV);
  }
}
