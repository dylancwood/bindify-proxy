import type { ServiceConfig } from './types';
import { log } from '../logger';

export interface DCRRegistration {
  client_id: string;
  registration_access_token?: string;
  registration_client_uri?: string;
  client_id_expires_at?: number;
}

/**
 * Get the full DCR registration object for a service, registering if needed.
 * Caches the registration in KV as `dcr:{serviceId}`.
 */
export async function getDCRRegistration(
  config: ServiceConfig,
  kv: KVNamespace,
  callbackUrl: string
): Promise<DCRRegistration> {
  const cacheKey = `dcr:${config.id}`;
  const cached = await kv.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as DCRRegistration;
  }
  return registerDCRClientFull(config, kv, callbackUrl);
}

/**
 * Get a DCR client_id for a service, registering if needed.
 * Caches the registration in KV as `dcr:{serviceId}`.
 */
export async function getDCRClientId(
  config: ServiceConfig,
  kv: KVNamespace,
  callbackUrl: string
): Promise<string> {
  const reg = await getDCRRegistration(config, kv, callbackUrl);
  return reg.client_id;
}

/**
 * Check if a DCR registration is still valid by hitting the registration_client_uri.
 * Takes a DCRRegistration directly (no KV lookup needed).
 * Returns true if alive or cannot be determined, false if definitively dead (404 or 401).
 */
export async function checkDCRRegistrationDirect(
  registration: DCRRegistration,
  config: ServiceConfig
): Promise<boolean> {
  if (!registration.registration_client_uri) {
    return true;
  }

  const uri = new URL(registration.registration_client_uri, config.dcrRegistrationUrl!).toString();
  const headers: Record<string, string> = {};
  if (registration.registration_access_token) {
    headers.Authorization = `Bearer ${registration.registration_access_token}`;
  }

  try {
    const response = await fetch(uri, { method: 'GET', headers });
    if (response.ok) return true;
    if (response.status === 404 || response.status === 401) {
      log.error('DCR registration dead', undefined, { clientId: registration.client_id, status: response.status });
      return false;
    }
    return true;
  } catch (err) {
    log.error('DCR registration check failed', err instanceof Error ? err : undefined, { clientId: registration.client_id });
    return true;
  }
}

async function registerDCRClientFull(
  config: ServiceConfig,
  kv: KVNamespace,
  callbackUrl: string
): Promise<DCRRegistration> {
  if (!config.dcrRegistrationUrl) {
    throw new Error(`Service ${config.id} has useDCR but no dcrRegistrationUrl`);
  }

  const body = {
    redirect_uris: [callbackUrl],
    client_name: 'Bindify',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  const response = await fetch(config.dcrRegistrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error('DCR registration failed', undefined, {
      serviceId: config.id,
      status: response.status,
      body: text,
    });
    throw new Error(`DCR registration failed: ${response.status} ${text}`);
  }

  const data = await response.json() as DCRRegistration;

  const kvOptions: KVNamespacePutOptions = {};
  if (data.client_id_expires_at) {
    const ttlSeconds = data.client_id_expires_at - Math.floor(Date.now() / 1000) - 300;
    if (ttlSeconds > 0) {
      kvOptions.expirationTtl = ttlSeconds;
    }
  }

  await kv.put(`dcr:${config.id}`, JSON.stringify(data), kvOptions);

  log.info('DCR registration successful', { serviceId: config.id, clientId: data.client_id });
  return data;
}
