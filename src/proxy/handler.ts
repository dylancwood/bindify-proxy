import type { Env } from '../index';
import type { TokenData, ApiKeyData } from '@bindify/types';
import { parseApiKey } from './resolve';
import { getService } from '../services/registry';
import { updateConnectionLastUsed, updateConnectionStatus, setSuspendedAt, clearNeedsReauthAt, setNeedsReauthAt, getUserById, getSubscriptionsByUserId, acquireRefreshLock } from '../db/queries';
import { isHealthCheckRequest, healthCheckResponse } from './healthcheck';
import { jsonRpcError, extractRequestId } from './errors';
import { encryptTokenData, deriveManagedEncryptionKey, encryptTokenDataWithKey, decryptTokenDataWithKey, decodeCredentials, getManagedKey, getActiveKeyVersion } from '../crypto';
import { getDCRClientId } from '../services/dcr';
import { getCallbackUrl } from '../utils/url';
import { log } from '../logger';
import { parseTokenResponseBody, validateTokenData } from '../token-parsing';
import { validateTokensBeforeWrite } from '../token-validation';
import { handleAuthError } from './auth-errors';
import { writeConnectionEvent } from '../db/connection-events';
import { withProxyCache, checkCachedAccessActive, decryptCacheTokens, writeProxyCache } from './kv-cache';
import type { ProxyCacheEntry } from './kv-cache';
import { parseConfig } from '../config';
import { getManagedEncryptionKeys } from '../index';

/**
 * Thrown when exponential backoff is exhausted and a cool-down lock has been set.
 * Callers should catch this and return a 503 response.
 */
export class RefreshCooldownError extends Error {
  constructor(public connectionId: string) {
    super(`Token refresh cool-down active for ${connectionId}`);
    this.name = 'RefreshCooldownError';
  }
}

/**
 * KV-based per-connection hourly rate limiter. Active only when
 * MCP_PROXY_RATE_LIMIT_PER_HOUR is set (staging). Returns a 429 Response
 * if the limit is exceeded, or null if the request should proceed.
 */
export async function checkProxyRateLimit(
  env: Pick<Env, 'KV'>,
  connectionId: string,
  limitStr: string | undefined
): Promise<Response | null> {
  if (!limitStr) return null;

  const limit = parseInt(limitStr, 10);
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `ratelimit:${connectionId}:${hourBucket}`;

  const current = parseInt(await env.KV.get(key) || '0', 10);
  if (current >= limit) {
    return Response.json(
      { error: 'rate_limited', message: 'Too many requests' },
      { status: 429 }
    );
  }

  await env.KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return null;
}

interface ProxyParams {
  service: string;
  secret1: string;   // base64url-encoded secret1 for DB lookup
  secret2: string;   // base64url-encoded secret2 for decryption
  credentials: string; // original 86-char blob for URL reconstruction
}

function parseProxyPath(request: Request): ProxyParams | null {
  const url = new URL(request.url);
  const path = url.pathname;

  // Credentials path: /mcp/{service}/{credentials}/(sse|messages)
  const credMatch = path.match(/^\/mcp\/([^/]+)\/([A-Za-z0-9_-]{86})\/(sse|messages)$/);
  if (credMatch) {
    try {
      const decoded = decodeCredentials(credMatch[2]);
      return { service: credMatch[1], secret1: decoded.secret1Encoded, secret2: decoded.secret2Encoded, credentials: credMatch[2] };
    } catch {
      // Invalid credentials — fall through
    }
  }

  // API key path: /mcp/{service}/(sse|messages) with Authorization header
  const apiKeyMatch = path.match(/^\/mcp\/([^/]+)\/(sse|messages)$/);
  if (apiKeyMatch) {
    const authHeader = request.headers.get('Authorization');
    const apiKey = authHeader?.replace(/^Bearer\s+/i, '');
    if (apiKey) {
      const parsed = parseApiKey(apiKey);
      if (parsed) {
        try {
          const decoded = decodeCredentials(parsed.credentials);
          return { service: apiKeyMatch[1], secret1: decoded.secret1Encoded, secret2: decoded.secret2Encoded, credentials: parsed.credentials };
        } catch {
          // Invalid credentials — fall through
        }
      }
    }
  }

  return null;
}

function parseProxyBasePath(request: Request): ProxyParams | null {
  const url = new URL(request.url);
  const path = url.pathname;

  // Credentials path: /mcp/{service}/{credentials} (no suffix)
  const credMatch = path.match(/^\/mcp\/([^/]+)\/([A-Za-z0-9_-]{86})$/);
  if (credMatch) {
    try {
      const decoded = decodeCredentials(credMatch[2]);
      return { service: credMatch[1], secret1: decoded.secret1Encoded, secret2: decoded.secret2Encoded, credentials: credMatch[2] };
    } catch {
      // Invalid credentials — fall through
    }
  }

  // API key path: /mcp/{service} with Authorization header
  const apiKeyMatch = path.match(/^\/mcp\/([^/]+)$/);
  if (apiKeyMatch) {
    const authHeader = request.headers.get('Authorization');
    const apiKey = authHeader?.replace(/^Bearer\s+/i, '');
    if (apiKey) {
      const parsed = parseApiKey(apiKey);
      if (parsed) {
        try {
          const decoded = decodeCredentials(parsed.credentials);
          return { service: apiKeyMatch[1], secret1: decoded.secret1Encoded, secret2: decoded.secret2Encoded, credentials: parsed.credentials };
        } catch {
          // Invalid credentials — fall through
        }
      }
    }
  }

  return null;
}

interface AuthResult {
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
}

/**
 * Stale-while-revalidate: refresh user/subscription metadata in KV cache from D1.
 */
async function refreshCacheMetadata(env: Env, secret1: string): Promise<void> {
  await withProxyCache(env, secret1, null, async (entry, write) => {
    const user = await getUserById(env.DB, entry.userId);
    if (!user) return;
    const subs = await getSubscriptionsByUserId(env.DB, entry.userId);
    const activeSub = subs.find(s => s.status === 'active' || s.status === 'trialing');
    const pastDueSub = subs.find(s => s.status === 'past_due');
    entry.user = {
      plan: user.plan,
      trialEndsAt: user.trial_ends_at,
      accessUntil: user.access_until,
    };
    entry.subscriptionStatus = activeSub?.status ?? pastDueSub?.status ?? null;
    entry.subscriptionPastDueSince = pastDueSub?.past_due_since ?? null;
    entry.cachedAt = new Date().toISOString();
    await write();
  });
}

type CacheSuccess = { auth: AuthResult; entry: ProxyCacheEntry };
type CacheError = { error: Response };
type CacheResult = CacheSuccess | CacheError;

/**
 * Perform the actual token refresh HTTP call, re-encrypt, and write to cache.
 * Never throws — returns existing tokens on any failure.
 */
async function performTokenRefresh(
  env: Env,
  entry: ProxyCacheEntry,
  tokens: TokenData,
  secret2: string,
  serviceId: string,
  secret1: string,
  ctx: ExecutionContext | null
): Promise<TokenData> {
  const serviceDef = getService(serviceId)!;

  if (!serviceDef.config.tokenUrl || (!serviceDef.config.clientIdEnvKey && !serviceDef.config.useDCR)) {
    return tokens;
  }

  // Get client credentials
  let clientId: string;
  if (serviceDef.config.useDCR && entry.dcrRegistration) {
    const keys = getManagedEncryptionKeys(env);
    const dcrMasterKey = getManagedKey(keys, entry.keyVersion);
    const dcrKey = await deriveManagedEncryptionKey(dcrMasterKey, entry.connectionId);
    const decryptedDcr = await decryptTokenDataWithKey(entry.dcrRegistration, dcrKey);
    const reg = JSON.parse(decryptedDcr);
    clientId = reg.client_id;
  } else if (serviceDef.config.useDCR) {
    const callbackUrl = getCallbackUrl(env);
    clientId = await getDCRClientId(serviceDef.config, env.KV, callbackUrl);
  } else {
    clientId = (env as any)[serviceDef.config.clientIdEnvKey!];
  }
  const clientSecret = serviceDef.config.clientSecretEnvKey ? (env as any)[serviceDef.config.clientSecretEnvKey] : undefined;

  // Build refresh request
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token!,
    client_id: clientId,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  let response: Response;
  try {
    response = await fetch(serviceDef.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    log.error('Token refresh fetch failed', err instanceof Error ? err : undefined, {
      connectionId: entry.connectionId,
      service: serviceId,
    });
    return tokens;
  }

  if (!response.ok) {
    const text = await response.text();
    log.error('Token refresh failed', undefined, {
      connectionId: entry.connectionId,
      service: serviceId,
      status: response.status,
    });

    // Fire-and-forget event write
    const eventWrite = writeConnectionEvent(env.DB, {
      connectionId: entry.connectionId,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: `Refresh returned ${response.status}`,
      upstreamStatus: response.status,
    }).catch(() => {});
    if (ctx) { ctx.waitUntil(eventWrite); } else { await eventWrite; }

    // Check for permanent failures — set needsReauthAt
    if (text.includes('invalid_grant') || text.includes('invalid_client')) {
      const reauthWrite = (async () => {
        const now = new Date().toISOString();
        await setNeedsReauthAt(env.DB, entry.connectionId, now);
        await withProxyCache(env, secret1, null, async (e, write) => {
          e.needsReauthAt = now;
          await write();
        });
      })().catch(() => {});
      if (ctx) { ctx.waitUntil(reauthWrite); } else { await reauthWrite; }
    }

    return tokens;
  }

  const rawBody = await response.text();
  const contentType = response.headers.get('content-type');
  const data = parseTokenResponseBody(rawBody, contentType);

  // Layer 1: validate raw provider response before override
  const requiresRefresh = serviceDef.config.requiresRefresh !== false;
  const rawValidation = validateTokenData(data, requiresRefresh);
  if (!rawValidation.valid) {
    log.error('Proxy refresh token validation failed', undefined, {
      connectionId: entry.connectionId,
      service: serviceId,
      error: rawValidation.error,
    });
    const eventWrite = writeConnectionEvent(env.DB, {
      connectionId: entry.connectionId,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: `Proxy refresh validation: ${rawValidation.error}`,
    }).catch(() => {});
    if (ctx) { ctx.waitUntil(eventWrite); } else { await eventWrite; }
    return tokens;
  }

  // Defensive validation
  const updated: TokenData = serviceDef.overrides?.parseTokenResponse
    ? serviceDef.overrides.parseTokenResponse(data)
    : {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? tokens.refresh_token,
        expires_at: data.expires_in
          ? Math.floor(Date.now() / 1000) + data.expires_in
          : Math.floor(Date.now() / 1000) + 315360000,
      };

  // Layer 2: validate final TokenData before encryption
  const preWriteValidation = validateTokensBeforeWrite(tokens, updated);
  if (!preWriteValidation.valid) {
    log.error('Proxy refresh pre-write validation failed', undefined, {
      connectionId: entry.connectionId,
      service: serviceId,
      error: preWriteValidation.error,
    });
    const eventWrite = writeConnectionEvent(env.DB, {
      connectionId: entry.connectionId,
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: `Pre-write validation: ${preWriteValidation.error}`,
    }).catch(() => {});
    if (ctx) { ctx.waitUntil(eventWrite); } else { await eventWrite; }
    return tokens;
  }

  log.info('Token refreshed via proxy (lock-based)', { connectionId: entry.connectionId, service: serviceId });

  // Clear cool-down lock on successful refresh
  await env.KV.delete(`refresh_cooldown:${entry.connectionId}`);

  // Fire-and-forget success event
  const eventWrite = writeConnectionEvent(env.DB, {
    connectionId: entry.connectionId,
    eventType: 'token_refresh',
    category: 'success',
    detail: 'Refreshed via proxy (lock-based)',
  }).catch(() => {});
  if (ctx) { ctx.waitUntil(eventWrite); } else { await eventWrite; }

  // Re-encrypt and write to cache
  let encrypted: string;
  if (entry.keyStorageMode === 'managed') {
    const keys = getManagedEncryptionKeys(env);
    const active = getActiveKeyVersion(keys);
    const encKey = await deriveManagedEncryptionKey(active.key, entry.connectionId);
    encrypted = await encryptTokenDataWithKey(JSON.stringify(updated), encKey);
    entry.keyVersion = active.version;
  } else {
    encrypted = await encryptTokenData(JSON.stringify(updated), secret2);
  }

  await withProxyCache(env, secret1, ctx, async (e, write) => {
    e.encryptedTokens = encrypted;
    await write({ isTokenUpdate: true });
  });

  // Clear needsReauthAt on successful refresh
  if (entry.needsReauthAt) {
    const clearReauth = (async () => {
      await clearNeedsReauthAt(env.DB, entry.connectionId);
    })().catch(() => {});
    if (ctx) { ctx.waitUntil(clearReauth); } else { await clearReauth; }
  }

  return updated;
}

/**
 * Attempt to refresh an expiring OAuth token using a D1-based lock.
 * Uses exponential backoff when waiting for another request's refresh.
 * Returns a 503 Response (via thrown RefreshCooldownError) if refresh is in cool-down.
 * Never throws otherwise — returns tokens (possibly stale) on any failure path.
 */
async function refreshTokenWithLock(
  env: Env,
  entry: ProxyCacheEntry,
  tokens: TokenData,
  secret1: string,
  secret2: string,
  serviceId: string,
  ctx: ExecutionContext | null
): Promise<TokenData> {
  const config = parseConfig(env.CONFIG);
  const now = Math.floor(Date.now() / 1000);
  const isExpiring = tokens.expires_at - now < 300; // 5 minutes

  if (!isExpiring) return tokens;

  // Non-expiring tokens: no refresh_token means permanent token — skip
  if (!tokens.refresh_token) {
    log.info('Skipping refresh — non-expiring token (no refresh_token)', {
      connectionId: entry.connectionId,
      service: serviceId,
      expiresAt: tokens.expires_at,
    });
    return tokens;
  }

  const serviceDef = getService(serviceId);
  if (!serviceDef) return tokens;

  // Check service override for shouldRefresh
  const shouldRefresh = serviceDef.overrides?.shouldRefresh
    ? serviceDef.overrides.shouldRefresh(tokens)
    : true; // isExpiring is already true at this point
  if (!shouldRefresh) return tokens;

  // Check cool-down lock before any lock acquisition
  const cooldownKey = `refresh_cooldown:${entry.connectionId}`;
  const cooldown = await env.KV.get(cooldownKey);
  if (cooldown) {
    // Token still valid — use it silently, don't 503
    if (tokens.expires_at > now) return tokens;
    // Token fully expired and cooldown active — signal 503
    throw new RefreshCooldownError(entry.connectionId);
  }

  const tokenStillValid = tokens.expires_at > now;

  // Try to acquire lock
  let lockAcquired: boolean;
  try {
    lockAcquired = await acquireRefreshLock(env.DB, entry.connectionId, config.refreshLockTtlSeconds);
  } catch {
    // D1 unavailable — use existing token
    return tokens;
  }

  if (lockAcquired) {
    return await performTokenRefresh(env, entry, tokens, secret2, serviceId, secret1, ctx);
  }

  // Lost lock race
  if (tokenStillValid) {
    // Token still valid — use it, winner will refresh for next request
    return tokens;
  }

  // Token fully expired — exponential backoff polling
  const backoffDelays = [100, 200, 400, 800, 1600];
  const maxTotalWaitMs = 6000;
  let totalWaited = 0;

  for (const delay of backoffDelays) {
    const waitTime = Math.min(delay, maxTotalWaitMs - totalWaited);
    if (waitTime <= 0) break;

    await new Promise(resolve => setTimeout(resolve, waitTime));
    totalWaited += waitTime;

    // Re-read cache to check if winner refreshed
    const refreshedRaw = await env.KV.get(`proxy:${secret1}`);
    if (refreshedRaw) {
      try {
        const parsed = JSON.parse(refreshedRaw) as ProxyCacheEntry;
        const refreshedTokens = await decryptCacheTokens(parsed, secret2, getManagedEncryptionKeys(env)) as TokenData;
        if (refreshedTokens.expires_at > Math.floor(Date.now() / 1000)) {
          return refreshedTokens;
        }
      } catch {
        // Decryption failed — continue backoff
      }
    }

    // Try to acquire lock on each iteration
    try {
      lockAcquired = await acquireRefreshLock(env.DB, entry.connectionId, config.refreshLockTtlSeconds);
    } catch {
      continue;
    }

    if (lockAcquired) {
      return await performTokenRefresh(env, entry, tokens, secret2, serviceId, secret1, ctx);
    }
  }

  // Backoff exhausted — set cool-down lock and signal 503
  await env.KV.put(cooldownKey, new Date().toISOString(), { expirationTtl: 60 });
  log.error('Token refresh backoff exhausted, entering cool-down', undefined, {
    connectionId: entry.connectionId,
    service: serviceId,
  });

  // Throw to signal caller to return 503
  throw new RefreshCooldownError(entry.connectionId);
}

/**
 * Build auth headers/queryParams from a ProxyCacheEntry + decrypted tokens.
 * For OAuth connections, performs lock-based token refresh if expiring.
 */
async function buildAuthFromCache(
  entry: ProxyCacheEntry,
  tokenData: TokenData | ApiKeyData,
  serviceId: string,
  env: Env,
  secret1: string,
  secret2: string,
  ctx: ExecutionContext | null
): Promise<AuthResult> {
  if (entry.authType === 'api_key') {
    const serviceDef = getService(serviceId);
    if (!serviceDef?.config.apiKey) throw new Error('Service does not support API key auth');
    const config = serviceDef.config.apiKey;
    const apiKeyData = tokenData as ApiKeyData;

    // Resolve auth mode's inject config (same logic as getAuthResult)
    const resolvedMode = entry.authMode && config.authModes
      ? config.authModes.find(m => m.id === entry.authMode)
      : undefined;
    const modeInject = resolvedMode?.proxyInject ?? resolvedMode?.inject;
    const inject = modeInject ?? config.proxyInject ?? config.inject;

    if (inject.type === 'header') {
      const prefix = inject.prefix ?? '';
      return { headers: { [inject.name]: `${prefix}${apiKeyData.api_key}` } };
    } else {
      return { headers: {}, queryParams: { [inject.name]: apiKeyData.api_key } };
    }
  }

  // OAuth — refresh if expiring, then use Bearer token
  const oauthTokens = tokenData as TokenData;
  const refreshedTokens = await refreshTokenWithLock(env, entry, oauthTokens, secret1, secret2, entry.service, ctx);
  return { headers: { Authorization: `Bearer ${refreshedTokens.access_token}` } };
}

/**
 * Check if an error is a RefreshCooldownError and return a 503 response if so.
 */
function cooldownErrorResponse(err: unknown, requestId: string | number | null): Response | null {
  if (err instanceof RefreshCooldownError) {
    const resp = jsonRpcError(requestId, -32007, 'Token refresh temporarily unavailable — retrying automatically. Contact support@bindify.dev if this persists.', 503);
    const headers = new Headers(resp.headers);
    headers.set('Retry-After', '60');
    return new Response(resp.body, { status: 503, headers });
  }
  return null;
}

function applyQueryParams(url: string, params?: Record<string, string>): string {
  if (!params) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

export async function handleProxySSE(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const params = parseProxyPath(request);
  if (!params) return new Response('Invalid proxy path', { status: 400 });

  const serviceDef = getService(params.service);
  if (!serviceDef) return new Response('Unknown service', { status: 404 });

  const config = parseConfig(env.CONFIG);

  const cacheResult = await withProxyCache<CacheResult>(env, params.secret1, ctx ?? null, async (entry, write): Promise<CacheResult> => {
    // Service mismatch check — prevent credential leaks to wrong upstream
    if (entry.service !== params.service) {
      return { error: new Response('Connection not found', { status: 404 }) };
    }

    // Connection status check
    if (entry.status === 'suspended') {
      return { error: new Response('Connection suspended — payment required', { status: 402 }) };
    }
    if (entry.status === 'error') {
      return { error: new Response('Connection error — please re-authenticate', { status: 502 }) };
    }

    // KV-based hourly rate limit (staging only)
    const kvRateLimitResponse = await checkProxyRateLimit(env, entry.connectionId, env.MCP_PROXY_RATE_LIMIT_PER_HOUR);
    if (kvRateLimitResponse) return { error: kvRateLimitResponse };

    // Billing check from cached snapshot
    const access = checkCachedAccessActive(entry.user, entry.subscriptionStatus, entry.subscriptionPastDueSince);
    if (!access.active) {
      if (entry.status !== 'suspended') {
        entry.status = 'suspended';
        await write();
        await updateConnectionStatus(env.DB, entry.connectionId, 'suspended');
        await setSuspendedAt(env.DB, entry.connectionId, new Date().toISOString());
      }
      return { error: new Response('Access denied', { status: 403 }) };
    }

    // Stale-while-revalidate
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > config.proxyCacheTtlSeconds * 1000 && ctx) {
      ctx.waitUntil(refreshCacheMetadata(env, params.secret1));
    }

    // Decrypt tokens and build auth
    let auth: AuthResult;
    try {
      const tokenData = await decryptCacheTokens(entry, params.secret2, getManagedEncryptionKeys(env));
      auth = await buildAuthFromCache(entry, tokenData, params.service, env, params.secret1, params.secret2, ctx ?? null);
    } catch (err) {
      if (err instanceof RefreshCooldownError) {
        return { error: Response.json({ error: 'temporarily_unavailable', message: 'Token refresh temporarily unavailable' }, { status: 503, headers: { 'Retry-After': '60' } }) };
      }
      handleAuthError(err, { id: entry.connectionId, service: entry.service } as any, params.service, params.secret1.slice(0, 8), ctx, env);
      return { error: new Response('Unauthorized — please re-authenticate', { status: 401 }) };
    }

    return { auth, entry };
  });

  if (!cacheResult) return new Response('Connection not found', { status: 404 });
  if ('error' in cacheResult) return cacheResult.error;

  const { auth, entry } = cacheResult;

  // Fire-and-forget proxy usage event
  if (ctx) {
    ctx.waitUntil(
      writeConnectionEvent(env.DB, {
        connectionId: entry.connectionId,
        eventType: 'proxy_request',
        category: 'success',
        detail: `${params.service}:sse`,
      }).catch(() => {})
    );
  }

  // Connect to upstream SSE
  const upstreamUrl = applyQueryParams(`${serviceDef.config.mcpBaseUrl}/sse`, auth.queryParams);
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: {
      ...auth.headers,
      Accept: 'text/event-stream',
    },
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    if (ctx) {
      ctx.waitUntil(
        writeConnectionEvent(env.DB, {
          connectionId: entry.connectionId,
          eventType: 'proxy_request',
          category: 'upstream_error',
          upstreamStatus: upstreamResponse.status,
          detail: `${params.service}:sse`,
        }).catch(() => {})
      );
    }
    return new Response(`Upstream error: ${upstreamResponse.status}`, { status: 502 });
  }

  const requestUrl = new URL(request.url);
  const proxyBase = `${requestUrl.origin}/mcp/${params.service}/${params.credentials}`;

  // Create a TransformStream that rewrites the endpoint event
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const pump = async () => {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;

          if (event.includes('event: endpoint') || event.includes('event:endpoint')) {
            const dataMatch = event.match(/data:\s*(.+)/);
            const originalData = dataMatch ? dataMatch[1].trim() : '';

            const parsed = new URL(originalData, serviceDef.config.mcpBaseUrl);
            const sessionId = parsed.searchParams.get('sessionId') || '';
            const upstreamMessageUrl = parsed.toString();

            await env.KV.put(`upstream:${sessionId}`, upstreamMessageUrl, { expirationTtl: 3600 });

            const rewrittenUrl = `${proxyBase}/messages?sessionId=${sessionId}`;
            const rewritten = event.replace(/data:\s*.+/, `data: ${rewrittenUrl}`);
            await writer.write(encoder.encode(rewritten + '\n\n'));
          } else {
            await writer.write(encoder.encode(event + '\n\n'));
          }
        }
      }
    } catch (err) {
      log.error('SSE stream error', err, { service: params.service, connectionId: entry.connectionId });
    } finally {
      try {
        await writer.close();
      } catch {
        // Expected: writer may already be closed if client disconnected
      }
    }
  };

  pump();

  // Update last_used_at non-blocking via waitUntil
  const sseLastUsedPromise = updateConnectionLastUsed(env.DB, entry.connectionId).catch(() => {});
  if (ctx) {
    ctx.waitUntil(sseLastUsedPromise);
    if (entry.needsReauthAt) {
      ctx.waitUntil((async () => {
        await clearNeedsReauthAt(env.DB, entry.connectionId);
        await withProxyCache(env, params.secret1, null, async (e, write) => {
          e.needsReauthAt = null;
          await write();
        });
      })().catch(() => {}));
    }
  }

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function handleProxyMessages(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const params = parseProxyPath(request);
  if (!params) return jsonRpcError(null, -32600, 'Invalid request path. Contact support@bindify.dev if you need help.', 400);

  const serviceDef = getService(params.service);
  if (!serviceDef) return jsonRpcError(null, -32006, 'Connection not found. Contact support@bindify.dev if you need help.', 404);

  // Check for health check short-circuit
  const healthCheck = await isHealthCheckRequest(request);
  if (healthCheck.isHealth) {
    try {
      const parsed = JSON.parse(healthCheck.body!);
      return healthCheckResponse(parsed.id);
    } catch {
      return healthCheckResponse();
    }
  }

  const requestId = extractRequestId(healthCheck.body);

  const config = parseConfig(env.CONFIG);

  const cacheResult = await withProxyCache<CacheResult>(env, params.secret1, ctx ?? null, async (entry, write): Promise<CacheResult> => {
    // Service mismatch check — prevent credential leaks to wrong upstream
    if (entry.service !== params.service) {
      return { error: jsonRpcError(requestId, -32001, 'Connection not found — this URL may have been deactivated. Reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 404) };
    }

    if (entry.status === 'suspended') {
      return { error: jsonRpcError(requestId, -32002, 'Connection suspended — payment required. Update billing at app.bindify.dev. Contact support@bindify.dev if you need help.', 402) };
    }
    if (entry.status === 'error') {
      return { error: jsonRpcError(requestId, -32003, 'Connection error — reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 502) };
    }

    // KV-based hourly rate limit (staging only)
    const kvRateLimitResponse = await checkProxyRateLimit(env, entry.connectionId, env.MCP_PROXY_RATE_LIMIT_PER_HOUR);
    if (kvRateLimitResponse) return { error: kvRateLimitResponse };

    // Billing check from cached snapshot
    const access = checkCachedAccessActive(entry.user, entry.subscriptionStatus, entry.subscriptionPastDueSince);
    if (!access.active) {
      if (entry.status !== 'suspended') {
        entry.status = 'suspended';
        await write();
        await updateConnectionStatus(env.DB, entry.connectionId, 'suspended');
        await setSuspendedAt(env.DB, entry.connectionId, new Date().toISOString());
      }
      return { error: jsonRpcError(requestId, -32004, 'Access denied — update your plan at app.bindify.dev. Contact support@bindify.dev if you need help.', 403) };
    }

    // Stale-while-revalidate
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > config.proxyCacheTtlSeconds * 1000 && ctx) {
      ctx.waitUntil(refreshCacheMetadata(env, params.secret1));
    }

    // Decrypt tokens and build auth
    let auth: AuthResult;
    try {
      const tokenData = await decryptCacheTokens(entry, params.secret2, getManagedEncryptionKeys(env));
      auth = await buildAuthFromCache(entry, tokenData, params.service, env, params.secret1, params.secret2, ctx ?? null);
    } catch (err) {
      const cooldownResp = cooldownErrorResponse(err, requestId);
      if (cooldownResp) return { error: cooldownResp };
      handleAuthError(err, { id: entry.connectionId, service: entry.service } as any, params.service, params.secret1.slice(0, 8), ctx, env);
      return { error: jsonRpcError(requestId, -32005, 'Unauthorized — reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 401) };
    }

    return { auth, entry };
  });

  if (!cacheResult) return jsonRpcError(requestId, -32001, 'Connection not found — this URL may have been deactivated. Reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 404);
  if ('error' in cacheResult) return cacheResult.error;

  const { auth, entry } = cacheResult;

  if (ctx) {
    ctx.waitUntil(
      writeConnectionEvent(env.DB, {
        connectionId: entry.connectionId,
        eventType: 'proxy_request',
        category: 'success',
        detail: `${params.service}:messages`,
      }).catch(() => {})
    );
  }

  const requestUrl = new URL(request.url);
  const sessionId = requestUrl.searchParams.get('sessionId') || '';

  const upstreamMessageUrl = await env.KV.get(`upstream:${sessionId}`);
  if (!upstreamMessageUrl) {
    return jsonRpcError(requestId, -32001, 'Session not found — SSE connection may have expired. Contact support@bindify.dev if you need help.', 404);
  }

  // Use pre-read body from health check if available, otherwise read fresh
  const body = healthCheck.body ?? await request.text();

  const upstreamResponse = await fetch(applyQueryParams(upstreamMessageUrl, auth.queryParams), {
    method: 'POST',
    headers: {
      ...auth.headers,
      'Content-Type': 'application/json',
    },
    body,
  });

  // Update last_used_at non-blocking via waitUntil
  const msgLastUsedPromise = updateConnectionLastUsed(env.DB, entry.connectionId).catch(() => {});
  if (ctx) {
    ctx.waitUntil(msgLastUsedPromise);
    if (entry.needsReauthAt) {
      ctx.waitUntil((async () => {
        await clearNeedsReauthAt(env.DB, entry.connectionId);
        await withProxyCache(env, params.secret1, null, async (e, write) => {
          e.needsReauthAt = null;
          await write();
        });
      })().catch(() => {}));
    }
  }

  if (upstreamResponse.status >= 400 && ctx) {
    ctx.waitUntil(
      writeConnectionEvent(env.DB, {
        connectionId: entry.connectionId,
        eventType: 'proxy_request',
        category: 'upstream_error',
        upstreamStatus: upstreamResponse.status,
        detail: `${params.service}:messages`,
      }).catch(() => {})
    );
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}

export async function handleProxyStreamableHTTP(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const params = parseProxyBasePath(request);
  if (!params) return jsonRpcError(null, -32600, 'Invalid request path. Contact support@bindify.dev if you need help.', 400);

  const serviceDef = getService(params.service);
  if (!serviceDef) return jsonRpcError(null, -32006, 'Connection not found. Contact support@bindify.dev if you need help.', 404);

  const method = request.method;

  // Health check short-circuit (POST only)
  let preReadBody: string | undefined;
  if (method === 'POST') {
    const healthCheck = await isHealthCheckRequest(request);
    if (healthCheck.isHealth) {
      try {
        const parsed = JSON.parse(healthCheck.body!);
        return healthCheckResponse(parsed.id);
      } catch {
        return healthCheckResponse();
      }
    }
    preReadBody = healthCheck.body;
  }

  // For GET requests, preReadBody is undefined → extractRequestId returns null
  const requestId = extractRequestId(preReadBody);

  const config = parseConfig(env.CONFIG);

  const cacheResult = await withProxyCache<CacheResult>(env, params.secret1, ctx ?? null, async (entry, write): Promise<CacheResult> => {
    // Service mismatch check — prevent credential leaks to wrong upstream
    if (entry.service !== params.service) {
      return { error: jsonRpcError(requestId, -32001, 'Connection not found — this URL may have been deactivated. Reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 404) };
    }

    if (entry.status === 'suspended') {
      return { error: jsonRpcError(requestId, -32002, 'Connection suspended — payment required. Update billing at app.bindify.dev. Contact support@bindify.dev if you need help.', 402) };
    }
    if (entry.status === 'error') {
      return { error: jsonRpcError(requestId, -32003, 'Connection error — reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 502) };
    }

    // KV-based hourly rate limit (staging only)
    const kvRateLimitResponse = await checkProxyRateLimit(env, entry.connectionId, env.MCP_PROXY_RATE_LIMIT_PER_HOUR);
    if (kvRateLimitResponse) return { error: kvRateLimitResponse };

    // Billing check from cached snapshot
    const access = checkCachedAccessActive(entry.user, entry.subscriptionStatus, entry.subscriptionPastDueSince);
    if (!access.active) {
      if (entry.status !== 'suspended') {
        entry.status = 'suspended';
        await write();
        await updateConnectionStatus(env.DB, entry.connectionId, 'suspended');
        await setSuspendedAt(env.DB, entry.connectionId, new Date().toISOString());
      }
      return { error: jsonRpcError(requestId, -32004, 'Access denied — update your plan at app.bindify.dev. Contact support@bindify.dev if you need help.', 403) };
    }

    // Stale-while-revalidate
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > config.proxyCacheTtlSeconds * 1000 && ctx) {
      ctx.waitUntil(refreshCacheMetadata(env, params.secret1));
    }

    // Decrypt tokens and build auth
    let auth: AuthResult;
    try {
      const tokenData = await decryptCacheTokens(entry, params.secret2, getManagedEncryptionKeys(env));
      auth = await buildAuthFromCache(entry, tokenData, params.service, env, params.secret1, params.secret2, ctx ?? null);
    } catch (err) {
      const cooldownResp = cooldownErrorResponse(err, requestId);
      if (cooldownResp) return { error: cooldownResp };
      handleAuthError(err, { id: entry.connectionId, service: entry.service } as any, params.service, params.secret1.slice(0, 8), ctx, env);
      return { error: jsonRpcError(requestId, -32005, 'Unauthorized — reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 401) };
    }

    return { auth, entry };
  });

  if (!cacheResult) return jsonRpcError(requestId, -32001, 'Connection not found — this URL may have been deactivated. Reconnect at app.bindify.dev to generate a new URL. Contact support@bindify.dev if you need help.', 404);
  if ('error' in cacheResult) return cacheResult.error;

  const { auth, entry } = cacheResult;

  if (ctx) {
    ctx.waitUntil(
      writeConnectionEvent(env.DB, {
        connectionId: entry.connectionId,
        eventType: 'proxy_request',
        category: 'success',
        detail: `${params.service}:streamable-http`,
      }).catch(() => {})
    );
  }

  // Update last_used_at non-blocking
  const lastUsedPromise = updateConnectionLastUsed(env.DB, entry.connectionId).catch(() => {});
  if (ctx) {
    ctx.waitUntil(lastUsedPromise);
    if (entry.needsReauthAt) {
      ctx.waitUntil((async () => {
        await clearNeedsReauthAt(env.DB, entry.connectionId);
        await withProxyCache(env, params.secret1, null, async (e, write) => {
          e.needsReauthAt = null;
          await write();
        });
      })().catch(() => {}));
    }
  }

  if (method === 'POST') {
    const body = preReadBody ?? await request.text();
    const sessionId = request.headers.get('Mcp-Session-Id');

    const upstreamHeaders: Record<string, string> = {
      ...auth.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      upstreamHeaders['Mcp-Session-Id'] = sessionId;
    }

    const upstreamResponse = await fetch(applyQueryParams(serviceDef.config.mcpBaseUrl, auth.queryParams), {
      method: 'POST',
      headers: upstreamHeaders,
      body,
    });

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('Content-Type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    const upstreamSessionId = upstreamResponse.headers.get('Mcp-Session-Id');
    if (upstreamSessionId) responseHeaders.set('Mcp-Session-Id', upstreamSessionId);
    responseHeaders.set('Cache-Control', 'no-cache');

    if (upstreamResponse.status >= 400 && ctx) {
      ctx.waitUntil(
        writeConnectionEvent(env.DB, {
          connectionId: entry.connectionId,
          eventType: 'proxy_request',
          category: 'upstream_error',
          upstreamStatus: upstreamResponse.status,
          detail: `${params.service}:streamable-http:post`,
        }).catch(() => {})
      );
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  if (method === 'GET') {
    const sessionId = request.headers.get('Mcp-Session-Id');

    const upstreamHeaders: Record<string, string> = {
      ...auth.headers,
      Accept: 'text/event-stream',
    };
    if (sessionId) {
      upstreamHeaders['Mcp-Session-Id'] = sessionId;
    }

    const upstreamResponse = await fetch(applyQueryParams(serviceDef.config.mcpBaseUrl, auth.queryParams), {
      headers: upstreamHeaders,
    });

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('Content-Type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    const upstreamSessionId = upstreamResponse.headers.get('Mcp-Session-Id');
    if (upstreamSessionId) responseHeaders.set('Mcp-Session-Id', upstreamSessionId);
    responseHeaders.set('Cache-Control', 'no-cache');

    if (upstreamResponse.status >= 400 && ctx) {
      ctx.waitUntil(
        writeConnectionEvent(env.DB, {
          connectionId: entry.connectionId,
          eventType: 'proxy_request',
          category: 'upstream_error',
          upstreamStatus: upstreamResponse.status,
          detail: `${params.service}:streamable-http:get`,
        }).catch(() => {})
      );
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return jsonRpcError(null, -32600, 'Method not allowed. Contact support@bindify.dev if you need help.', 405);
}
