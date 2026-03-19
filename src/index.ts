// src/index.ts
import { handleAuthorize, handleCallback, handleClaimCallback, handleApiKeyConnect } from './api/connections';
import { handleGetMe } from './api/me';
import { handleListConnections, handleDeleteConnection, handleUpdateConnectionLabel } from './api/connections-api';
import { handleCreateCheckout, handleCreatePortal, handleUpdateQuantity, handleVerifyCheckout } from './api/billing';
import { handleDeleteAccount } from './api/account-api';
import { handleListServices } from './api/services-api';
import { handleProxySSE, handleProxyMessages, handleProxyStreamableHTTP } from './proxy/handler';
import { jsonRpcError } from './proxy/errors';
import { getService } from './services/registry';
import type { ServiceId } from '@bindify/types';
import { isHealthCheckRequest, healthCheckResponse } from './proxy/healthcheck';
import { verifyClerkToken, extractBearerToken, decodeJwtPayload, deriveJwksUrl } from './auth/clerk';
import { ensureUser, MaxUsersReachedError } from './auth/middleware';
import { verifyWebhookSignature } from './billing/stripe';
import { processWebhookEvent, isHandledEvent } from './billing/webhook';
import { getUserById } from './db/queries';
import { cleanupStaleSuspendedConnections } from './cleanup';
import { handleScheduledRefresh } from './scheduler';
import { checkKvD1Consistency } from './consistency';
import { handleGenerateNonce, handleSupportTicket } from './api/support';
import { handleCspReport } from './api/csp-report';
import { log } from './logger';
import { parseAllowlist, isAllowlisted } from './bot-detection/allowlist';
import { BlocklistCache } from './bot-detection/blocklist-cache';
import { log404Event } from './bot-detection/log-404';
import { parseManagedKeys } from './crypto';
import type { ManagedKeyEntry } from './crypto';
import { sendNewUserNotification } from './notifications';

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

// Module-level state for bot detection (persists for Worker isolate lifetime)
let allowlist: Set<string> | null = null;
let blocklistCache: BlocklistCache | null = null;
let managedKeysCache: ManagedKeyEntry[] | null = null;

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  ADMIN_URL: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_JWKS_URL?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_CONNECTIONS: string;
  CLERK_SECRET_KEY: string;
  MANAGED_ENCRYPTION_MASTER_KEY?: string; // Legacy fallback — remove after rotation
  MANAGED_ENCRYPTION_KEYS?: string; // JSON array: [{"version":1,"key":"..."}]
  SECRET_ENV_PREFIX: string;
  // Staging-only restrictions (not set in production — checks skipped when absent)
  MAX_USERS?: string;
  MCP_PROXY_RATE_LIMIT_PER_HOUR?: string;
  IP_ALLOWLIST?: string;
  BLOCKLIST_CACHE_TTL_MS?: string;
  E2E_BYPASS_TOKEN?: string; // If set, requests with matching X-E2E-Bypass header skip bot detection
  CONFIG?: string;
  // Zoho Desk integration (optional — support endpoint returns 503 if not configured)
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  ZOHO_ORG_ID?: string;
  ZOHO_DEPARTMENT_ID?: string;
  ZOHO_ACCOUNTS_URL?: string;
  ZOHO_DESK_URL?: string;
  SMTP2GO_API_KEY?: string;
  ADMIN_NOTIFICATION_EMAIL?: string;
  OPS_NOTIFICATION_ORIGIN_EMAIL?: string;
}

export function getManagedEncryptionKeys(env: Env): ManagedKeyEntry[] {
  if (managedKeysCache) return managedKeysCache;

  if (env.MANAGED_ENCRYPTION_KEYS) {
    managedKeysCache = parseManagedKeys(env.MANAGED_ENCRYPTION_KEYS);
  } else if (env.MANAGED_ENCRYPTION_MASTER_KEY) {
    // Fallback: wrap legacy single key as version 1
    managedKeysCache = [{ version: 1, key: env.MANAGED_ENCRYPTION_MASTER_KEY }];
  } else {
    throw new Error('Neither MANAGED_ENCRYPTION_KEYS nor MANAGED_ENCRYPTION_MASTER_KEY is set');
  }

  return managedKeysCache;
}

function getAllowedOrigins(env: Env): string[] {
  return env.ADMIN_URL.split(',').map(u => u.trim());
}

function corsHeaders(env: Env, request?: Request): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  const origin = request?.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

async function authenticateRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<{ userId: string } | Response> {
  const authHeader = request.headers.get('Authorization');
  const token = extractBearerToken(authHeader);
  if (!token) {
    return Response.json(
      { error: 'unauthorized', message: 'Missing or invalid Authorization header' },
      { status: 401, headers: corsHeaders(env, request) }
    );
  }

  const jwksUrl = env.CLERK_JWKS_URL || deriveJwksUrl(env.CLERK_PUBLISHABLE_KEY);
  const result = await verifyClerkToken(token, jwksUrl);
  if (!result) {
    return Response.json(
      { error: 'unauthorized', message: 'Invalid or expired token' },
      { status: 401, headers: corsHeaders(env, request) }
    );
  }

  // Extract email from JWT payload (token already verified, but wrap defensively)
  let email: string | undefined;
  try {
    email = decodeJwtPayload(token).email as string | undefined;
  } catch {
    // JWT already verified; if decode fails, proceed without email
  }

  // Lazy provisioning
  const maxUsers = env.MAX_USERS ? parseInt(env.MAX_USERS, 10) : undefined;
  try {
    const { user, isNew } = await ensureUser(env.DB, result.userId, { maxUsers, email: email ?? undefined });
    if (isNew && env.SECRET_ENV_PREFIX === 'live') {
      ctx.waitUntil(sendNewUserNotification(env, user));
    }
  } catch (err) {
    if (err instanceof MaxUsersReachedError) {
      return Response.json(
        { error: 'max_users_reached', message: 'Maximum number of users reached' },
        { status: 403, headers: corsHeaders(env, request) }
      );
    }
    throw err;
  }

  return { userId: result.userId };
}

const COMING_SOON_SERVICES = new Set(['figma']);

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Logs 404 events for /mcp/ paths, but ONLY when the 404 originates from our
 * own "connection not found" logic (not from an upstream server returning 404).
 * We detect this via the X-Bindify-Not-Found header set by our error functions.
 * This is safe to log with full credentials because 404 means the credentials
 * don't correspond to any real connection — needed for enumeration detection.
 */
function maybeLog404(
  response: Response, path: string, ip: string,
  request: Request, ctx: ExecutionContext, env: Env
): Response {
  // Skip 404 logging for E2E bypass requests — prevents CI runners from
  // accumulating 404 events that would trigger bot detection blocks.
  const e2eBypass = env.E2E_BYPASS_TOKEN
    && request.headers.get('X-E2E-Bypass') === env.E2E_BYPASS_TOKEN;
  if (e2eBypass) return response;
  if (response.status === 404 && path.startsWith('/mcp/') && response.headers.get('X-Bindify-Not-Found') === '1') {
    const urlSegment = path.replace(/^\/mcp\//, '');
    ctx.waitUntil(log404Event(env.DB, {
      ip, rawUrl: request.url, urlSegment, headers: request.headers, cf: (request as any).cf,
    }));
  }
  return response;
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get('CF-Connecting-IP') || '';

  // Lazy-init allow-list and blocklist cache
  if (!allowlist) {
    allowlist = parseAllowlist(env.IP_ALLOWLIST);
  }
  if (!blocklistCache) {
    const ttl = env.BLOCKLIST_CACHE_TTL_MS ? parseInt(env.BLOCKLIST_CACHE_TTL_MS, 10) : 30000;
    blocklistCache = new BlocklistCache(ttl);
  }

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    // CSP report endpoint is public — allow any origin
    if (path === '/api/csp-report') {
      const origin = request.headers.get('Origin') || '';
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    const origin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);
    if (origin && !allowed.includes(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }

  // Skip blocklist for E2E bypass token (CI environments) or allowlisted IPs
  const e2eBypass = env.E2E_BYPASS_TOKEN
    && request.headers.get('X-E2E-Bypass') === env.E2E_BYPASS_TOKEN;
  if (!e2eBypass && !isAllowlisted(allowlist, ip)) {
    // Check in-memory cache first, then KV on miss
    let blocked = blocklistCache.get(ip);
    if (blocked === null) {
      const kvResult = await env.KV.get(`blocked:${ip}`);
      blocked = kvResult !== null;
      blocklistCache.set(ip, blocked);
    }
    if (blocked) {
      return addCorsHeaders(
        Response.json(
          { error: 'rate_limited', message: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': '600' } }
        ),
        env,
        request
      );
    }
  }

  try {
    // ─── Landing page ───
    if (path === '/' && method === 'GET') {
      return new Response(
        `<!DOCTYPE html>
<html><head><title>Bindify</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 0 20px;">
  <h1>Bindify</h1>
  <p>MCP Auth Proxy</p>
  <p><a href="/dashboard" style="display: inline-block; padding: 12px 24px; background: #ff6600; color: white; text-decoration: none; border-radius: 6px;">Open Dashboard</a></p>
</body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }

    // ─── Public proxy routes (no Clerk auth) ───

    // Streamable HTTP: POST/GET /mcp/:service/:credentials
    const streamableMatch = path.match(/^\/mcp\/([^/]+)\/([A-Za-z0-9_-]{86})$/);
    if (streamableMatch) {
      if (method === 'POST' || method === 'GET') {
        return maybeLog404(await handleProxyStreamableHTTP(request, env, ctx), path, ip, request, ctx, env);
      }
      return jsonRpcError(null, -32600, 'Method not allowed. Contact support@bindify.dev if you need help.', 405);
    }

    // Streamable HTTP: POST/GET /mcp/:service (API key auth)
    const streamableApiKeyMatch = path.match(/^\/mcp\/([^/]+)$/);
    if (streamableApiKeyMatch) {
      if (method === 'POST' || method === 'GET') {
        return maybeLog404(await handleProxyStreamableHTTP(request, env, ctx), path, ip, request, ctx, env);
      }
      return jsonRpcError(null, -32600, 'Method not allowed. Contact support@bindify.dev if you need help.', 405);
    }

    // Legacy SSE: GET /mcp/:service/:credentials/sse
    // Legacy SSE: POST /mcp/:service/:credentials/messages
    const dualSecretMatch = path.match(/^\/mcp\/([^/]+)\/([A-Za-z0-9_-]{86})\/(sse|messages)$/);
    if (dualSecretMatch) {
      const serviceId = dualSecretMatch[1];
      const endpoint = dualSecretMatch[3]; // Was [4], now [3] since secrets are one group
      const svc = getService(serviceId);

      // Health check still works on legacy routes regardless of transport
      if (endpoint === 'messages' && method === 'POST') {
        const healthCheck = await isHealthCheckRequest(request);
        if (healthCheck.isHealth) {
          try {
            const parsed = JSON.parse(healthCheck.body!);
            return healthCheckResponse(parsed.id);
          } catch {
            return healthCheckResponse();
          }
        }
      }

      // If service uses streamable-http, return helpful error
      if (svc && svc.config.transport === 'streamable-http') {
        return new Response(
          'This service uses Streamable HTTP transport. Use the base URL without /sse or /messages suffix.',
          { status: 400 }
        );
      }

      if (endpoint === 'sse' && method === 'GET') {
        return maybeLog404(await handleProxySSE(request, env, ctx), path, ip, request, ctx, env);
      }
      if (endpoint === 'messages' && method === 'POST') {
        return maybeLog404(await handleProxyMessages(request, env, ctx), path, ip, request, ctx, env);
      }
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    // Legacy SSE API key: GET /mcp/:service/sse, POST /mcp/:service/messages
    const apiKeyMatch = path.match(/^\/mcp\/([^/]+)\/(sse|messages)$/);
    if (apiKeyMatch) {
      const serviceId = apiKeyMatch[1];
      const endpoint = apiKeyMatch[2];
      const svc = getService(serviceId);

      if (endpoint === 'messages' && method === 'POST') {
        const healthCheck = await isHealthCheckRequest(request);
        if (healthCheck.isHealth) {
          try {
            const parsed = JSON.parse(healthCheck.body!);
            return healthCheckResponse(parsed.id);
          } catch {
            return healthCheckResponse();
          }
        }
      }

      if (svc && svc.config.transport === 'streamable-http') {
        return new Response(
          'This service uses Streamable HTTP transport. Use the base URL without /sse or /messages suffix.',
          { status: 400 }
        );
      }

      if (endpoint === 'sse' && method === 'GET') {
        return maybeLog404(await handleProxySSE(request, env, ctx), path, ip, request, ctx, env);
      }
      if (endpoint === 'messages' && method === 'POST') {
        return maybeLog404(await handleProxyMessages(request, env, ctx), path, ip, request, ctx, env);
      }
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    // ─── Stripe webhook (signature verification, not Clerk) ───
    if (path === '/api/webhooks/stripe' && method === 'POST') {
      const body = await request.text();
      const signature = request.headers.get('stripe-signature') || '';
      const valid = await verifyWebhookSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        return Response.json({ error: 'Invalid signature' }, { status: 400 });
      }
      const event = JSON.parse(body);
      if (!isHandledEvent(event.type)) {
        log.info('Unhandled webhook event type', { eventType: event.type });
        return Response.json({ error: 'Unhandled event type', type: event.type }, { status: 400 });
      }
      try {
        await processWebhookEvent(env, event);
        return Response.json({ received: true });
      } catch (err) {
        log.error('Webhook processing failed', err, { eventType: event.type });
        return Response.json({ error: 'processing_failed' }, { status: 500 });
      }
    }

    // ─── OAuth callback (no Clerk auth — redirect from upstream provider) ───
    if (path === '/api/connections/callback' && method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const baseUrl = url.origin;
      const callbackUrl = `${baseUrl}/api/connections/callback`;
      const adminOrigin = getAllowedOrigins(env)[0];
      return handleCallback(code, state, env, callbackUrl, adminOrigin);
    }

    // ─── Public API routes ───
    if (path === '/api/services' && method === 'GET') {
      const response = handleListServices();
      return addCorsHeaders(response, env, request);
    }

    if (path === '/api/interest' && method === 'POST') {
      const body = await request.json().catch(() => ({})) as { service?: string };
      const service = typeof body.service === 'string' ? body.service.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '') : null;
      if (!service) {
        return addCorsHeaders(
          Response.json({ error: 'invalid_request', message: 'service is required' }, { status: 400 }),
          env, request
        );
      }
      if (!COMING_SOON_SERVICES.has(service)) {
        return addCorsHeaders(
          Response.json({ error: 'invalid_request', message: 'unknown service' }, { status: 400 }),
          env, request
        );
      }
      // Optionally extract user_id from JWT if present — no auth required
      let userId: string | null = null;
      const authHeader = request.headers.get('Authorization');
      const token = extractBearerToken(authHeader);
      if (token) {
        const interestJwksUrl = env.CLERK_JWKS_URL || deriveJwksUrl(env.CLERK_PUBLISHABLE_KEY);
        const result = await verifyClerkToken(token, interestJwksUrl).catch(() => null);
        if (result) userId = result.userId;
      }
      const rawIp = request.headers.get('CF-Connecting-IP') || null;
      const hashedIp = rawIp ? await hashIp(rawIp) : null;
      // Rate-limit via Cache API: silent dedup within 1 hour per IP+service
      const cache = caches.default;
      const cacheKey = new Request(`https://interest-cache/${hashedIp}/${service}`);
      const cached = await cache.match(cacheKey);
      if (cached) {
        return addCorsHeaders(Response.json({ ok: true }), env, request);
      }
      try {
        await env.DB.prepare(
          'INSERT INTO interest_log (service, user_id, ip) VALUES (?, ?, ?)'
        ).bind(service, userId, hashedIp).run();
      } catch {
        // best-effort analytics, don't fail the request
      }
      await cache.put(cacheKey, new Response('1', { headers: { 'Cache-Control': 'max-age=3600' } }));
      return addCorsHeaders(
        Response.json({ ok: true }, { status: 200 }),
        env, request
      );
    }

    // ─── Support ticket routes (public, nonce-protected) ───
    if (path === '/api/support/nonce' && method === 'POST') {
      const response = await handleGenerateNonce(env);
      return addCorsHeaders(response, env, request);
    }

    if (path === '/api/support/ticket' && method === 'POST') {
      const response = await handleSupportTicket(request, env);
      return addCorsHeaders(response, env, request);
    }

    // ─── CSP violation report (public, rate-limited) ───
    if (path === '/api/csp-report' && method === 'POST') {
      const response = await handleCspReport(request);
      const origin = request.headers.get('Origin') || '';
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', origin || '*');
      return new Response(response.body, { status: response.status, headers });
    }

    if (path === '/api/csp-report' && method !== 'POST') {
      return new Response(null, { status: 405 });
    }

    // ─── Authenticated API routes (Clerk JWT) ───
    if (path.startsWith('/api/')) {
      const auth = await authenticateRequest(request, env, ctx);
      if (auth instanceof Response) return auth;
      const { userId } = auth;
      const baseUrl = url.origin;

      // GET /api/me
      if (path === '/api/me' && method === 'GET') {
        const response = await handleGetMe(env, userId);
        return addCorsHeaders(response, env, request);
      }

      // GET /api/connections/claim?token=...
      if (path === '/api/connections/claim' && method === 'GET') {
        const token = url.searchParams.get('token') || '';
        if (!token) {
          return addCorsHeaders(
            Response.json({ error: 'invalid_request', message: 'token is required' }, { status: 400 }),
            env, request
          );
        }
        const response = await handleClaimCallback(userId, token, env);
        return addCorsHeaders(response, env, request);
      }

      // GET /api/connections
      if (path === '/api/connections' && method === 'GET') {
        const response = await handleListConnections(env.DB, userId, baseUrl);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/connections/:service/authorize
      const authorizeMatch = path.match(/^\/api\/connections\/([^/]+)\/authorize$/);
      if (authorizeMatch && method === 'POST') {
        const serviceId = authorizeMatch[1];
        // ServiceId may move to DB-driven definitions in the future, at which point the union type should be replaced with runtime validation only
        if (!getService(serviceId)) {
          return addCorsHeaders(
            Response.json({ error: 'not_found', message: `Unknown service: ${serviceId}` }, { status: 404 }),
            env, request
          );
        }
        const callbackUrl = `${baseUrl}/api/connections/callback`;
        const body = await request.json().catch(() => ({})) as { keyStorageMode?: 'managed' | 'zero_knowledge'; replaceConnectionId?: string };
        const keyStorageMode = body.keyStorageMode === 'managed' ? 'managed' : 'zero_knowledge';
        const response = await handleAuthorize(userId, serviceId as ServiceId, env, callbackUrl, keyStorageMode, body.replaceConnectionId);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/connections/:service/api-key
      const apiKeyConnectMatch = path.match(/^\/api\/connections\/([^/]+)\/api-key$/);
      if (apiKeyConnectMatch && method === 'POST') {
        const serviceId = apiKeyConnectMatch[1];
        const body = await request.json() as { apiKey?: string; fields?: Record<string, string>; replaceConnectionId?: string; authMode?: string; application?: string; skipApplicationValidation?: boolean };
        if (!body.apiKey && !body.fields) {
          return Response.json(
            { error: 'invalid_request', message: 'apiKey or fields is required' },
            { status: 400, headers: corsHeaders(env, request) }
          );
        }
        const adminOrigin = getAllowedOrigins(env)[0];
        const response = await handleApiKeyConnect(userId, serviceId, body.apiKey, env, adminOrigin, baseUrl, body.replaceConnectionId, body.fields, body.authMode, body.application, body.skipApplicationValidation);
        return addCorsHeaders(response, env, request);
      }

      // PATCH /api/connections/:id
      const patchMatch = path.match(/^\/api\/connections\/([^/]+)$/);
      if (patchMatch && method === 'PATCH') {
        const connectionId = patchMatch[1];
        const body = await request.json().catch(() => ({})) as { label?: string };
        if (typeof body.label !== 'string') {
          return addCorsHeaders(
            Response.json({ error: 'invalid_request', message: 'label is required' }, { status: 400 }),
            env, request
          );
        }
        if (body.label.length > 256) {
          return addCorsHeaders(
            Response.json({ error: 'invalid_request', message: 'label must be 256 characters or fewer' }, { status: 400 }),
            env, request
          );
        }
        const response = await handleUpdateConnectionLabel(env.DB, connectionId, userId, body.label);
        return addCorsHeaders(response, env, request);
      }

      // DELETE /api/connections/:id
      const deleteMatch = path.match(/^\/api\/connections\/([^/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        const connectionId = deleteMatch[1];
        const response = await handleDeleteConnection(env.DB, env.KV, connectionId, userId);
        return addCorsHeaders(response, env, request);
      }

      // DELETE /api/account
      if (path === '/api/account' && method === 'DELETE') {
        const user = await getUserById(env.DB, userId);
        const response = await handleDeleteAccount(env.DB, env.KV, userId, user?.stripe_customer_id ?? null, env.STRIPE_SECRET_KEY, env.CLERK_SECRET_KEY);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/billing/checkout
      if (path === '/api/billing/checkout' && method === 'POST') {
        const body = await request.json() as { quantity?: number };
        const quantity = Math.max(1, Math.floor(body.quantity || 1));
        const checkoutOrigin = getAllowedOrigins(env)[0];
        const returnUrl = `${checkoutOrigin}/dashboard`;
        const response = await handleCreateCheckout(userId, quantity, env, returnUrl);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/billing/verify-checkout
      if (path === '/api/billing/verify-checkout' && method === 'POST') {
        const body = await request.json() as { session_id?: string };
        if (!body.session_id || typeof body.session_id !== 'string') {
          return Response.json(
            { error: 'invalid_request', message: 'session_id is required' },
            { status: 400, headers: corsHeaders(env, request) }
          );
        }
        const response = await handleVerifyCheckout(userId, body.session_id, env);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/billing/update-quantity
      if (path === '/api/billing/update-quantity' && method === 'POST') {
        const body = await request.json() as { quantity?: number };
        if (!body.quantity || typeof body.quantity !== 'number') {
          return Response.json(
            { error: 'invalid_request', message: 'quantity is required' },
            { status: 400, headers: corsHeaders(env, request) }
          );
        }
        const response = await handleUpdateQuantity(env.DB, userId, body.quantity, env);
        return addCorsHeaders(response, env, request);
      }

      // POST /api/billing/portal
      if (path === '/api/billing/portal' && method === 'POST') {
        const user = await getUserById(env.DB, userId);
        if (!user?.stripe_customer_id) {
          return Response.json(
            { error: 'no_subscription', message: 'No billing account found' },
            { status: 400, headers: corsHeaders(env, request) }
          );
        }
        const portalOrigin = getAllowedOrigins(env)[0];
        const returnUrl = `${portalOrigin}/dashboard`;
        const response = await handleCreatePortal(user.stripe_customer_id, env, returnUrl);
        return addCorsHeaders(response, env, request);
      }

      return Response.json(
        { error: 'not_found', message: 'Unknown API route' },
        { status: 404, headers: corsHeaders(env, request) }
      );
    }

    if (path.startsWith('/mcp/')) {
      const urlSegment = path.replace(/^\/mcp\//, '');
      ctx.waitUntil(log404Event(env.DB, {
        ip, rawUrl: request.url, urlSegment, headers: request.headers, cf: (request as any).cf,
      }));
    }
    return Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 });
  } catch (err) {
    log.error('Unhandled request error', err, { method, path });
    return Response.json(
      { error: 'internal_error', message: 'Internal server error' },
      { status: 500, headers: corsHeaders(env, request) }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const response = await handleRequest(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set('x-bindify-version', VERSION);
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Content-Security-Policy', "default-src 'none'");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      log.error('Unhandled fetch wrapper error', err);
      return Response.json(
        { error: 'internal_error', message: 'Internal server error' },
        { status: 500 }
      );
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case '0 */6 * * *': {
        const cleanupCount = await cleanupStaleSuspendedConnections(env.DB, env.KV, 60);
        if (cleanupCount > 0) {
          log.info('Cleanup completed', { removedCount: cleanupCount });
        }
        break;
      }
      case '0 2,8,14,20 * * *':
        await handleScheduledRefresh(env);
        break;
      case '0 4,10,16,22 * * *': {
        const result = await checkKvD1Consistency(env);
        log.info('Consistency check completed', result);
        break;
      }
      default:
        log.warn('Unknown cron pattern', { cron: event.cron });
    }
  },
};

function addCorsHeaders(response: Response, env: Env, request?: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env, request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
