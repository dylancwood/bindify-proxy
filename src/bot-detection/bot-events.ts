import { log } from '../logger';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'cf-access-client-secret',
]);

export function filterHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

/**
 * Extracts the 86-char credentials blob from a proxy path.
 * Uses the same strict regex constraints as the proxy route parsers (BIN-155 format).
 * Returns null for paths that don't match any known structure.
 */
export function extractSecretSegment(path: string): string | null {
  const match = path.match(
    /^\/mcp\/[^/]+\/([A-Za-z0-9_-]{86})(?:\/(sse|messages))?$/
  );
  return match ? match[1] : null;
}

export type BotEventReason = 'invalid_credentials' | 'unknown_service' | 'route_not_found';

interface BotEventParams {
  reason: BotEventReason;
  ip: string;
  rawUrl: string;
  urlSegment: string;
  headers: Headers;
  cf: { asn?: number | string; asOrganization?: string; country?: string } | undefined;
  e2eBypassToken?: string;
  e2eBypassHeader?: string;
}

export async function logPossibleBotEvent(db: D1Database, params: BotEventParams): Promise<void> {
  if (params.e2eBypassToken && params.e2eBypassHeader === params.e2eBypassToken) {
    return;
  }

  try {
    const filteredHeaders = filterHeaders(params.headers);
    const secretSegment = extractSecretSegment('/mcp/' + params.urlSegment);
    await db.prepare(`
      INSERT INTO proxy_404_log (ip, raw_url, url_segment, secret_segment, headers, timestamp, asn, asn_org, country, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      params.ip,
      params.rawUrl,
      params.urlSegment,
      secretSegment,
      JSON.stringify(filteredHeaders),
      Math.floor(Date.now() / 1000),
      params.cf?.asn?.toString() ?? null,
      params.cf?.asOrganization ?? null,
      params.cf?.country ?? null,
      params.reason,
    ).run();
  } catch (err) {
    log.error('Failed to log possible bot event', err, { ip: params.ip, reason: params.reason, urlSegment: params.urlSegment });
  }
}
