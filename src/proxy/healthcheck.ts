const HEALTH_CHECK_METHODS = ['ping', 'health'];

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

export async function isHealthCheckRequest(request: Request): Promise<{ isHealth: boolean; body?: string }> {
  if (request.method !== 'POST') return { isHealth: false };
  try {
    const body = await request.text();
    const parsed = JSON.parse(body);
    const method = parsed.method?.toLowerCase();
    if (HEALTH_CHECK_METHODS.includes(method)) return { isHealth: true, body };
    return { isHealth: false, body };
  } catch {
    return { isHealth: false };
  }
}

export function healthCheckResponse(id?: number | string): Response {
  return Response.json({ jsonrpc: '2.0', result: { status: 'ok', version: VERSION }, id: id ?? 1 });
}
