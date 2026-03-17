import type { Env } from '../index';
import type { Connection } from '../../../../shared/types';
import { writeConnectionEvent } from '../db/connection-events';
import { setNeedsReauthAt } from '../db/queries';
import { log } from '../logger';

export interface CategorizedError {
  eventType: string;
  category: string;
  detail: string;
  upstreamStatus?: number;
}

export function categorizeAuthError(err: unknown): CategorizedError {
  const message = err instanceof Error ? err.message : String(err);

  // KV miss
  if (message.includes('Session not found')) {
    return { eventType: 'auth', category: 'kv_miss', detail: message };
  }

  // Token refresh failure
  if (message.includes('Token refresh failed')) {
    // Extract upstream status: "Token refresh failed: 401 ..."
    const statusMatch = message.match(/Token refresh failed: (\d+)/);
    const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

    // Check for invalid_grant/invalid_client in the message
    if (message.includes('invalid_grant') || message.includes('invalid_client')) {
      return {
        eventType: 'token_refresh',
        category: 'invalid_grant',
        detail: message,
        upstreamStatus,
      };
    }

    return {
      eventType: 'token_refresh',
      category: 'refresh_failed',
      detail: message,
      upstreamStatus,
    };
  }

  // Decryption failure — Web Crypto API errors
  if (
    message.includes('operation-specific reason') ||
    message.includes('decrypt') ||
    message.includes('OperationError')
  ) {
    return { eventType: 'auth', category: 'decryption_failed', detail: message };
  }

  // Unknown
  return { eventType: 'auth', category: 'unknown', detail: message };
}

/**
 * Handles an auth error from getAuthResult: logs, writes event, flags reauth.
 * All writes are fire-and-forget. Returns void — caller still returns the generic 401.
 */
export function handleAuthError(
  err: unknown,
  connection: Connection,
  serviceId: string,
  secret1Prefix: string,
  ctx: ExecutionContext | undefined,
  env: Env
): void {
  const categorized = categorizeAuthError(err);

  log.error('Auth failed', err instanceof Error ? err : undefined, {
    connectionId: connection.id,
    service: serviceId,
    secret1Prefix,
    errorCategory: categorized.category,
    eventType: categorized.eventType,
  });

  const eventPromise = writeConnectionEvent(env.DB, {
    connectionId: connection.id,
    eventType: categorized.eventType,
    category: categorized.category,
    detail: categorized.detail,
    upstreamStatus: categorized.upstreamStatus,
  }).catch(() => {});

  // Flag for reauth only on permanent failures (not transient refresh errors)
  const needsReauth = categorized.category === 'invalid_grant';

  const reauthPromise = needsReauth
    ? setNeedsReauthAt(env.DB, connection.id, new Date().toISOString()).catch(() => {})
    : Promise.resolve();

  if (ctx) {
    ctx.waitUntil(eventPromise);
    ctx.waitUntil(reauthPromise);
  }
}
