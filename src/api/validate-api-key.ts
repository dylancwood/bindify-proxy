import type { ApiKeyConfig, ApiKeyAuthMode } from '../services/types';

type FetchFn = typeof fetch;

export function buildUpstreamRequest(
  apiKey: string,
  config: ApiKeyConfig,
  mode?: ApiKeyAuthMode
): { url: string; init: RequestInit } {
  const inject = mode?.inject ?? config.inject;
  const headers: Record<string, string> = {};
  let url = config.validate.url;

  if (inject.type === 'header') {
    const prefix = inject.prefix ?? '';
    headers[inject.name] = `${prefix}${apiKey}`;
  } else {
    const parsed = new URL(url);
    parsed.searchParams.set(inject.name, apiKey);
    url = parsed.toString();
  }

  const init: RequestInit = {
    method: config.validate.method,
    headers,
  };

  // Merge any extra validation headers
  if (config.validate.headers) {
    Object.assign(headers, config.validate.headers);
  }

  if (config.validate.body) {
    headers['Content-Type'] = 'application/json';
    // Default Accept for POST-with-body (MCP streamable HTTP expects this);
    // service-specific validate.headers can override via Object.assign above.
    if (!headers['Accept']) {
      headers['Accept'] = 'application/json, text/event-stream';
    }
    init.body = config.validate.body;
  }

  return { url, init };
}

export interface ValidationResult {
  valid: boolean;
  status?: number;
  error?: string;
  responseBody?: string;
  requestUrl?: string;
  requestMethod?: string;
}

export async function validateUpstreamApiKey(
  apiKey: string,
  config: ApiKeyConfig,
  modeOrFetch?: ApiKeyAuthMode | FetchFn,
  maybeFetchFn?: FetchFn
): Promise<ValidationResult> {
  const mode = typeof modeOrFetch === 'function' ? undefined : modeOrFetch;
  const fetchFn = typeof modeOrFetch === 'function' ? modeOrFetch : (maybeFetchFn ?? fetch);
  try {
    const { url, init } = buildUpstreamRequest(apiKey, config, mode);
    const response = await fetchFn(url, init);
    const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    const truncatedBody = body.length > 1024 ? body.slice(0, 1024) + '...(truncated)' : body;
    if (response.status === config.validate.expectStatus) {
      return { valid: true, status: response.status, requestUrl: url, requestMethod: config.validate.method };
    }
    return { valid: false, status: response.status, error: `Upstream returned ${response.status}`, responseBody: truncatedBody, requestUrl: url, requestMethod: config.validate.method };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { valid: false, error: `Upstream request failed: ${message}`, requestUrl: config.validate.url, requestMethod: config.validate.method };
  }
}
