import type { Env } from '../index';
import type { ServiceId, TokenData, Connection } from '@bindify/types';
import { getService } from '../services/registry';
import { checkCanConnect } from '../auth/entitlements';
import { createConnection, updateConnectionLastRefreshed, getConnectionsByUserId, getConnectionById, deleteConnection, getUserById, getSubscriptionsByUserId, updateConnectionStatus, setSuspendedAt } from '../db/queries';
import { generateRandomString, generateCodeChallenge, generateSecretBytes, encodeCredentials, encodeSecret1, base64UrlEncode, encryptTokenData, deriveManagedEncryptionKey, encryptTokenDataWithKey, getActiveKey, PERMANENT_TOKEN_EXPIRY_SECONDS } from '../crypto';
import { getManagedEncryptionKeys } from '../index';
import { validateUpstreamApiKey } from './validate-api-key';
import { fetchMcpToolsList, validateApplicationTools } from './validate-application';
import { getDCRClientId, getDCRRegistration } from '../services/dcr';
import { buildProxyCacheEntry, writeProxyCache, deleteProxyCache } from '../proxy/kv-cache';
import { generateDefaultLabel } from './connections-api';
import { log } from '../logger';
import { parseTokenResponseBody, validateTokenData } from '../token-parsing';
import { writeConnectionEvent } from '../db/connection-events';

interface PKCEOAuthState {
  userId: string;
  serviceId: ServiceId;
  codeVerifier?: string;
  callbackUrl: string;
  keyStorageMode: 'managed' | 'zero_knowledge';
  replaceConnectionId?: string;
}

export async function handleAuthorize(
  userId: string,
  serviceId: ServiceId,
  env: Env,
  callbackUrl: string,
  keyStorageMode: 'managed' | 'zero_knowledge' = 'zero_knowledge',
  replaceConnectionId?: string
): Promise<Response> {
  // Check entitlement
  const canConnect = await checkCanConnect(env.DB, userId, replaceConnectionId);
  if (!canConnect.allowed) {
    return Response.json({ error: 'forbidden', message: canConnect.reason }, { status: 403 });
  }

  // Verify ownership of connection being replaced
  if (replaceConnectionId) {
    const connections = await getConnectionsByUserId(env.DB, userId);
    const existing = connections.find(c => c.id === replaceConnectionId);
    if (!existing) {
      return Response.json({ error: 'not_found', message: 'Connection to replace not found' }, { status: 404 });
    }
  }

  const serviceDef = getService(serviceId);
  if (!serviceDef) {
    return Response.json({ error: 'not_found', message: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  const config = serviceDef.config;

  if (!config.authorizationUrl || !config.tokenUrl || (!config.clientIdEnvKey && !config.useDCR)) {
    return Response.json(
      { error: 'not_supported', message: `${serviceId} does not support OAuth` },
      { status: 400 }
    );
  }

  let clientId: string;
  if (config.useDCR) {
    try {
      clientId = await getDCRClientId(config, env.KV, callbackUrl);
    } catch (err) {
      log.error('DCR registration failed', err instanceof Error ? err : undefined, { serviceId });
      return Response.json({ error: 'dcr_failed', message: 'Dynamic client registration failed' }, { status: 502 });
    }
  } else {
    clientId = (env as any)[config.clientIdEnvKey!];
    if (!clientId) {
      return Response.json({ error: 'config_error', message: `Missing client ID for ${serviceId}` }, { status: 500 });
    }
  }

  const state = generateRandomString(32);
  const pkceState: PKCEOAuthState = {
    userId,
    serviceId,
    callbackUrl,
    keyStorageMode,
    replaceConnectionId,
  };

  const authUrl = new URL(config.authorizationUrl);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);

  const scopes = config.scopes ?? [];
  if (scopes.length > 0) {
    authUrl.searchParams.set('scope', scopes.join(' '));
  }

  if (config.usePKCE ?? false) {
    const codeVerifier = generateRandomString(64);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    pkceState.codeVerifier = codeVerifier;
  }

  // Use custom buildAuthUrl if provided
  if (serviceDef.overrides?.buildAuthUrl) {
    const customUrl = serviceDef.overrides.buildAuthUrl(config, Object.fromEntries(authUrl.searchParams));
    await env.KV.put(`oauth:${state}`, JSON.stringify(pkceState), { expirationTtl: 600 });
    return Response.json({ url: customUrl });
  }

  await env.KV.put(`oauth:${state}`, JSON.stringify(pkceState), { expirationTtl: 600 });
  return Response.json({ url: authUrl.toString() });
}

export async function handleCallback(
  code: string,
  state: string,
  env: Env,
  callbackUrl: string,
  adminUrl: string
): Promise<Response> {
  // Retrieve PKCE state from KV
  const raw = await env.KV.get(`oauth:${state}`);
  if (!raw) {
    return new Response('Invalid or expired state parameter', { status: 400 });
  }

  const pkceState = JSON.parse(raw) as PKCEOAuthState;
  await env.KV.delete(`oauth:${state}`);

  const serviceDef = getService(pkceState.serviceId);
  if (!serviceDef) {
    return new Response('Unknown service', { status: 400 });
  }

  const config = serviceDef.config;

  if (!config.tokenUrl || (!config.clientIdEnvKey && !config.useDCR)) {
    return new Response('Service does not support OAuth', { status: 400 });
  }

  let clientId: string;
  let dcrRegistration: string | null = null;
  if (config.useDCR) {
    try {
      const registration = await getDCRRegistration(config, env.KV, callbackUrl);
      clientId = registration.client_id;
      dcrRegistration = JSON.stringify(registration);
    } catch (err) {
      log.error('DCR registration failed in callback', err instanceof Error ? err : undefined, { serviceId: pkceState.serviceId });
      return new Response('Dynamic client registration failed', { status: 502 });
    }
  } else {
    clientId = (env as any)[config.clientIdEnvKey!];
  }
  const clientSecret = config.clientSecretEnvKey ? (env as any)[config.clientSecretEnvKey] : undefined;

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: clientId,
  });

  if (pkceState.codeVerifier) {
    tokenBody.set('code_verifier', pkceState.codeVerifier);
  }
  if (clientSecret) {
    tokenBody.set('client_secret', clientSecret);
  }

  const tokenResponse = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenBody.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    log.error('OAuth token exchange failed', undefined, {
      handler: 'handleCallback',
      serviceId: pkceState.serviceId,
      status: tokenResponse.status,
      body: text,
    });
    return new Response('Token exchange failed', { status: 502 });
  }

  const rawBody = await tokenResponse.text();
  const contentType = tokenResponse.headers.get('content-type');

  const tokenData = parseTokenResponseBody(rawBody, contentType);

  const requiresRefresh = serviceDef.config.requiresRefresh !== false;
  const validation = validateTokenData(tokenData, requiresRefresh);
  if (!validation.valid) {
    log.error('Token response validation failed', undefined, {
      handler: 'handleCallback',
      serviceId: pkceState.serviceId,
      error: validation.error,
      keysPresent: validation.keysPresent,
    });
    return new Response(`Token exchange failed: ${validation.error}`, { status: 502 });
  }

  if (validation.warnings.length > 0) {
    log.warn('Token response warnings', {
      handler: 'handleCallback',
      serviceId: pkceState.serviceId,
      warnings: validation.warnings,
      contentType,
      keysPresent: validation.keysPresent,
    });
  }

  const tokens: TokenData = serviceDef.overrides?.parseTokenResponse
    ? serviceDef.overrides.parseTokenResponse(tokenData)
    : {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? '',
        expires_at: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : Math.floor(Date.now() / 1000) + PERMANENT_TOKEN_EXPIRY_SECONDS,
      };

  // Generate dual secrets — secret2 is NEVER stored (zero-knowledge)
  const secret1Bytes = generateSecretBytes(32);
  const secret2Bytes = generateSecretBytes(32);
  const credentials = encodeCredentials(secret1Bytes, secret2Bytes);
  const secret1 = encodeSecret1(secret1Bytes);
  const secret2 = base64UrlEncode(secret2Bytes);
  const apiKey = `bnd_${env.SECRET_ENV_PREFIX || 'test'}_${credentials}`;
  const connectionId = crypto.randomUUID();
  const keyStorageMode = pkceState.keyStorageMode || 'zero_knowledge';

  // Encrypt tokens based on storage mode
  const keys = await getManagedEncryptionKeys(env);
  const active = getActiveKey(keys);
  const activeKeyFingerprint = active.fingerprint;
  let encryptedTokens: string;
  if (keyStorageMode === 'managed') {
    const managedKey = await deriveManagedEncryptionKey(active.key, connectionId);
    encryptedTokens = await encryptTokenDataWithKey(JSON.stringify(tokens), managedKey);
  } else {
    encryptedTokens = await encryptTokenData(JSON.stringify(tokens), secret2);
  }

  // Encrypt DCR registration with managed key (always, regardless of keyStorageMode)
  let encryptedDcrRegistration: string | null = null;
  if (dcrRegistration) {
    const dcrKey = await deriveManagedEncryptionKey(active.key, connectionId);
    encryptedDcrRegistration = await encryptTokenDataWithKey(dcrRegistration, dcrKey);
  }

  // Generate default label
  const userConns = await getConnectionsByUserId(env.DB, pkceState.userId);
  const sameServiceCount = userConns.filter(c => c.service === pkceState.serviceId).length;
  const defaultLabel = generateDefaultLabel(pkceState.serviceId, sameServiceCount + 1);

  // Suspend old connection before creating new one to prevent duplicate active credentials
  if (pkceState.replaceConnectionId) {
    const oldConn = await getConnectionById(env.DB, pkceState.replaceConnectionId);
    await updateConnectionStatus(env.DB, pkceState.replaceConnectionId, 'suspended');
    await setSuspendedAt(env.DB, pkceState.replaceConnectionId, new Date().toISOString());
    if (oldConn) {
      await deleteProxyCache(env, oldConn.secret_url_segment_1).catch(() => {});
    }
  }

  // Create connection in D1 — only secret1 is stored (for lookup)
  try {
    await createConnection(env.DB, {
      id: connectionId,
      user_id: pkceState.userId,
      service: pkceState.serviceId,
      secret_url_segment_1: secret1,
      status: 'active',
      key_storage_mode: keyStorageMode,
      auth_type: 'oauth',
      auth_mode: null,
      application: null,
      label: defaultLabel,
      dcr_registration: encryptedDcrRegistration,
      encrypted_tokens: encryptedTokens,
      needs_reauth_at: null,
      key_fingerprint: activeKeyFingerprint,
      managed_key_fingerprint: keyStorageMode === 'managed' ? activeKeyFingerprint : '',
      dcr_key_fingerprint: encryptedDcrRegistration ? activeKeyFingerprint : '',
    });
  } catch (err) {
    // Restore old connection if new one fails to create
    if (pkceState.replaceConnectionId) {
      await updateConnectionStatus(env.DB, pkceState.replaceConnectionId, 'active').catch(() => {});
      await setSuspendedAt(env.DB, pkceState.replaceConnectionId, null).catch(() => {});
    }
    throw err;
  }

  // Populate proxy cache
  try {
    const cacheUser = await getUserById(env.DB, pkceState.userId);
    if (cacheUser) {
      const subs = await getSubscriptionsByUserId(env.DB, pkceState.userId);
      const activeSub = subs.find(s => s.status === 'active' || s.status === 'trialing');
      const pastDueSub = subs.find(s => s.status === 'past_due');
      const cacheConnection: Connection = {
        id: connectionId,
        user_id: pkceState.userId,
        service: pkceState.serviceId,
        secret_url_segment_1: secret1,
        status: 'active',
        key_storage_mode: keyStorageMode,
        auth_type: 'oauth',
        auth_mode: null,
        application: null,
        label: defaultLabel,
        dcr_registration: encryptedDcrRegistration,
        encrypted_tokens: encryptedTokens,
        key_version: 1,
        needs_reauth_at: null,
        suspended_at: null,
        last_used_at: null,
        last_refreshed_at: null,
        metadata: null,
        created_at: new Date().toISOString(),
        key_fingerprint: activeKeyFingerprint,
        managed_key_fingerprint: keyStorageMode === 'managed' ? activeKeyFingerprint : '',
        dcr_key_fingerprint: encryptedDcrRegistration ? activeKeyFingerprint : '',
      };
      const cacheEntry = buildProxyCacheEntry(
        cacheConnection,
        cacheUser,
        activeSub?.status ?? pastDueSub?.status ?? null,
        pastDueSub?.past_due_since ?? null,
        encryptedTokens
      );
      await writeProxyCache(env, secret1, cacheEntry);
    }
  } catch (err) {
    log.error('Failed to populate proxy cache', err instanceof Error ? err : undefined, {
      handler: 'handleCallback',
      connectionId,
    });
    // Don't fail the callback — connection was created successfully
  }

  // Set initial last_refreshed_at for managed connections to prevent immediate cron refresh
  if (keyStorageMode === 'managed') {
    await updateConnectionLastRefreshed(env.DB, connectionId);
  }

  // Write connection_created event
  const warningsSuffix = validation.warnings.length > 0
    ? `; warnings: ${validation.warnings.join(', ')}`
    : '';
  await writeConnectionEvent(env.DB, {
    connectionId,
    eventType: 'connection_created',
    category: 'oauth',
    detail: `service:${pkceState.serviceId}, mode:${keyStorageMode}${warningsSuffix}`,
  }).catch(() => {});

  // If replacing an existing connection, delete the old one (already suspended above)
  if (pkceState.replaceConnectionId) {
    try {
      await deleteConnection(env.DB, pkceState.replaceConnectionId);
      await writeConnectionEvent(env.DB, {
        connectionId,
        eventType: 'reauth',
        category: 'success',
        detail: `Replaced connection ${pkceState.replaceConnectionId}`,
      }).catch(() => {});
    } catch (err) {
      // Old connection is already suspended, so no duplicate active credential exposure
      log.error('Failed to delete superseded connection', err, {
        handler: 'handleCallback',
        replaceConnectionId: pkceState.replaceConnectionId,
      });
    }
  }

  // Store secrets in KV with a claim token (secrets never in URL params)
  const claimToken = generateRandomString(32);
  const workerOrigin = new URL(callbackUrl).origin;
  const svc = getService(pkceState.serviceId);
  const suffix = svc?.config.transport === 'streamable-http' ? '' : '/sse';
  const claimData = {
    userId: pkceState.userId,
    connected: pkceState.serviceId,
    secret_url: `${workerOrigin}/mcp/${pkceState.serviceId}/${credentials}${suffix}`,
    api_key: apiKey,
    key_storage_mode: keyStorageMode,
  };
  await env.KV.put(`callback_claim:${claimToken}`, JSON.stringify(claimData), { expirationTtl: 300 });

  // Redirect to admin dashboard with only the claim token (not secrets)
  const dashboardUrl = new URL('/dashboard', adminUrl);
  dashboardUrl.searchParams.set('callback_token', claimToken);

  return Response.redirect(dashboardUrl.toString(), 302);
}

export async function handleClaimCallback(
  userId: string,
  token: string,
  env: Env
): Promise<Response> {
  const raw = await env.KV.get(`callback_claim:${token}`);
  if (!raw) {
    return Response.json({ error: 'not_found', message: 'Invalid or expired claim token' }, { status: 404 });
  }

  const claimData = JSON.parse(raw) as {
    userId: string;
    connected: string;
    secret_url: string;
    api_key: string;
    key_storage_mode: string;
  };

  // Verify the claiming user matches the user who created the connection
  if (claimData.userId !== userId) {
    return Response.json({ error: 'forbidden', message: 'Claim token does not belong to this user' }, { status: 403 });
  }

  // Delete the claim token (one-time use)
  await env.KV.delete(`callback_claim:${token}`);

  return Response.json({
    connected: claimData.connected,
    secret_url: claimData.secret_url,
    api_key: claimData.api_key,
    key_storage_mode: claimData.key_storage_mode,
  });
}

export async function handleApiKeyConnect(
  userId: string,
  serviceId: string,
  apiKey: string | undefined,
  env: Env,
  adminUrl: string,
  workerOrigin: string,
  replaceConnectionId?: string,
  fields?: Record<string, string>,
  authMode?: string,
  application?: string,
  skipApplicationValidation?: boolean
): Promise<Response> {
  // Check entitlement
  const canConnect = await checkCanConnect(env.DB, userId, replaceConnectionId);
  if (!canConnect.allowed) {
    return Response.json({ error: 'forbidden', message: canConnect.reason }, { status: 403 });
  }

  // Verify ownership of connection being replaced
  if (replaceConnectionId) {
    const connections = await getConnectionsByUserId(env.DB, userId);
    const existing = connections.find(c => c.id === replaceConnectionId);
    if (!existing) {
      return Response.json({ error: 'not_found', message: 'Connection to replace not found' }, { status: 404 });
    }
  }

  const serviceDef = getService(serviceId);
  if (!serviceDef) {
    return Response.json({ error: 'not_found', message: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  if (!serviceDef.config.apiKey) {
    return Response.json({ error: 'not_supported', message: `${serviceId} does not support API key authentication` }, { status: 400 });
  }

  const apiKeyConfig = serviceDef.config.apiKey;

  // Validate application value if provided
  if (application) {
    const validApps = apiKeyConfig.applications?.map(a => a.id);
    if (!validApps || !validApps.includes(application)) {
      return Response.json(
        { error: 'invalid_request', message: `Unknown application: ${application}` },
        { status: 400 }
      );
    }
  }

  // Resolve auth mode if service has authModes
  const resolvedMode = authMode && apiKeyConfig.authModes
    ? apiKeyConfig.authModes.find(m => m.id === authMode)
    : undefined;

  if (authMode && !apiKeyConfig.authModes) {
    return Response.json({ error: 'invalid_request', message: `${serviceId} does not support auth modes` }, { status: 400 });
  }

  if (authMode && apiKeyConfig.authModes && !resolvedMode) {
    return Response.json({ error: 'invalid_request', message: `Unknown auth mode: ${authMode}` }, { status: 400 });
  }

  // Assemble API key from fields if provided
  let resolvedApiKey: string;
  const modeAssemble = resolvedMode?.assembleApiKey;
  const topAssemble = apiKeyConfig.assembleApiKey;

  if (fields && modeAssemble) {
    resolvedApiKey = modeAssemble(fields);
  } else if (fields && topAssemble) {
    resolvedApiKey = topAssemble(fields);
  } else if (fields && !modeAssemble && !topAssemble) {
    // Single-field mode (e.g., service_account) — extract the value
    const values = Object.values(fields);
    if (values.length === 1) {
      resolvedApiKey = values[0];
    } else {
      return Response.json({ error: 'invalid_request', message: 'Fields provided but no assembleApiKey and multiple fields' }, { status: 400 });
    }
  } else if (apiKey) {
    resolvedApiKey = apiKey;
  } else {
    return Response.json({ error: 'invalid_request', message: 'apiKey or fields is required' }, { status: 400 });
  }

  // Validate the API key against upstream
  const validation = await validateUpstreamApiKey(resolvedApiKey, apiKeyConfig, resolvedMode);
  if (!validation.valid) {
    const detail = validation.status === 401 || validation.status === 403
      ? 'The API key was rejected by the upstream service. Please check your key and try again.'
      : validation.error ?? 'API key validation failed.';

    // Log failed validation attempt (no connection created)
    await writeConnectionEvent(env.DB, {
      connectionId: null,
      userId,
      eventType: 'api_key_validation',
      category: 'upstream_rejected',
      detail: `service:${serviceId}, url:${validation.requestUrl}, method:${validation.requestMethod}, status:${validation.status ?? 'N/A'}, error:${validation.error ?? 'none'}`,
      upstreamStatus: validation.status,
      encryptedPayload: validation.responseBody,
    }).catch(() => {});

    return Response.json({ error: 'invalid_api_key', message: detail }, { status: 400 });
  }

  // Advisory validation: check that the token has tools for the selected application.
  // skipApplicationValidation is client-controlled — this is by design. The validation is
  // purely informational (helps users catch misconfigured tokens), not a security gate.
  if (application && application !== 'other' && !skipApplicationValidation && serviceDef.config.apiKey?.applications) {
    const appConfig = serviceDef.config.apiKey.applications.find(a => a.id === application);
    if (appConfig && appConfig.toolPattern) {
      try {
        const inject = resolvedMode?.inject ?? apiKeyConfig.inject;
        const prefix = inject.type === 'header' ? (inject.prefix ?? '') : '';
        const authHeader = inject.type === 'header' ? `${prefix}${resolvedApiKey}` : '';

        const { tools } = await fetchMcpToolsList(
          serviceDef.config.mcpBaseUrl,
          authHeader
        );
        const appValidation = validateApplicationTools(application, tools);
        if (!appValidation.valid) {
          return Response.json({
            error: 'application_mismatch',
            message: `This token doesn't appear to have access to ${appConfig.label}.`,
            tools: appValidation.allTools,
          }, { status: 400 });
        }
      } catch (err) {
        log.error('Application tool validation failed', err instanceof Error ? err : undefined, {
          handler: 'handleApiKeyConnect',
          application,
        });
        // Don't block — auth validation already passed
      }
    }
  }

  // Generate dual secrets — secret2 is NEVER stored (zero-knowledge)
  const secret1Bytes = generateSecretBytes(32);
  const secret2Bytes = generateSecretBytes(32);
  const credentials = encodeCredentials(secret1Bytes, secret2Bytes);
  const secret1 = encodeSecret1(secret1Bytes);
  const secret2 = base64UrlEncode(secret2Bytes);
  const bndApiKey = `bnd_${env.SECRET_ENV_PREFIX || 'test'}_${credentials}`;
  const connectionId = crypto.randomUUID();

  // Encrypt API key with secret2-derived key (always zero-knowledge)
  const encryptedData = await encryptTokenData(JSON.stringify({ api_key: resolvedApiKey }), secret2);

  // Generate default label
  const userConns = await getConnectionsByUserId(env.DB, userId);
  const sameServiceCount = userConns.filter(c => c.service === serviceId).length;
  const defaultLabel = generateDefaultLabel(serviceId, sameServiceCount + 1);

  // Suspend old connection before creating new one to prevent duplicate active credentials
  if (replaceConnectionId) {
    const oldConn = await getConnectionById(env.DB, replaceConnectionId);
    await updateConnectionStatus(env.DB, replaceConnectionId, 'suspended');
    await setSuspendedAt(env.DB, replaceConnectionId, new Date().toISOString());
    if (oldConn) {
      await deleteProxyCache(env, oldConn.secret_url_segment_1).catch(() => {});
    }
  }

  // Build metadata for audit trail
  const metadata = skipApplicationValidation
    ? JSON.stringify({ skippedApplicationValidation: true, application: application ?? null })
    : null;

  // Create connection in D1
  try {
    await createConnection(env.DB, {
      id: connectionId,
      user_id: userId,
      // ServiceId may move to DB-driven definitions in the future, at which point the union type should be replaced with runtime validation only
      service: serviceId as ServiceId,
      secret_url_segment_1: secret1,
      status: 'active',
      key_storage_mode: 'zero_knowledge',
      auth_type: 'api_key',
      auth_mode: authMode ?? null,
      application: application ?? null,
      label: defaultLabel,
      dcr_registration: null,
      encrypted_tokens: encryptedData,
      needs_reauth_at: null,
      metadata,
    });
  } catch (err) {
    // Restore old connection if new one fails to create
    if (replaceConnectionId) {
      await updateConnectionStatus(env.DB, replaceConnectionId, 'active').catch(() => {});
      await setSuspendedAt(env.DB, replaceConnectionId, null).catch(() => {});
    }
    throw err;
  }

  // Populate proxy cache
  try {
    const cacheUser = await getUserById(env.DB, userId);
    if (cacheUser) {
      const subs = await getSubscriptionsByUserId(env.DB, userId);
      const activeSub = subs.find(s => s.status === 'active' || s.status === 'trialing');
      const pastDueSub = subs.find(s => s.status === 'past_due');
      const cacheConnection: Connection = {
        id: connectionId,
        user_id: userId,
        service: serviceId as ServiceId,
        secret_url_segment_1: secret1,
        status: 'active',
        key_storage_mode: 'zero_knowledge',
        auth_type: 'api_key',
        auth_mode: authMode ?? null,
        application: application ?? null,
        label: defaultLabel,
        dcr_registration: null,
        encrypted_tokens: encryptedData,
        key_version: 1,
        needs_reauth_at: null,
        suspended_at: null,
        last_used_at: null,
        last_refreshed_at: null,
        metadata: null,
        created_at: new Date().toISOString(),
        key_fingerprint: '',
        managed_key_fingerprint: '',
        dcr_key_fingerprint: '',
      };
      const cacheEntry = buildProxyCacheEntry(
        cacheConnection,
        cacheUser,
        activeSub?.status ?? pastDueSub?.status ?? null,
        pastDueSub?.past_due_since ?? null,
        encryptedData
      );
      await writeProxyCache(env, secret1, cacheEntry);
    }
  } catch (err) {
    log.error('Failed to populate proxy cache', err instanceof Error ? err : undefined, {
      handler: 'handleApiKeyConnect',
      connectionId,
    });
    // Don't fail — connection was created successfully
  }

  await writeConnectionEvent(env.DB, {
    connectionId,
    eventType: 'connection_created',
    category: 'api_key',
    detail: `service:${serviceId}, mode:zero_knowledge`,
  }).catch(() => {});

  // If replacing an existing connection, delete the old one (already suspended above)
  if (replaceConnectionId) {
    try {
      await deleteConnection(env.DB, replaceConnectionId);
      await writeConnectionEvent(env.DB, {
        connectionId,
        eventType: 'reauth',
        category: 'success',
        detail: `Replaced connection ${replaceConnectionId}`,
      }).catch(() => {});
    } catch (err) {
      // Old connection is already suspended, so no duplicate active credential exposure
      log.error('Failed to delete superseded connection', err, {
        handler: 'handleApiKeyConnect',
        replaceConnectionId,
      });
    }
  }

  // Store secrets in KV with a claim token (same mechanism as OAuth flow)
  const claimToken = generateRandomString(32);
  const suffix = serviceDef.config.transport === 'streamable-http' ? '' : '/sse';
  const claimData = {
    userId,
    connected: serviceId,
    secret_url: `${workerOrigin}/mcp/${serviceId}/${credentials}${suffix}`,
    api_key: bndApiKey,
    key_storage_mode: 'zero_knowledge',
  };
  await env.KV.put(`callback_claim:${claimToken}`, JSON.stringify(claimData), { expirationTtl: 300 });

  const dashboardUrl = new URL('/dashboard', adminUrl);
  dashboardUrl.searchParams.set('callback_token', claimToken);

  return Response.json({ redirectUrl: dashboardUrl.toString() });
}
