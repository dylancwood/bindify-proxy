import { log } from '../logger';

const MAX_REPORTS_PER_MINUTE = 10;
const MAX_BODY_BYTES = 10_240; // 10 KB

export async function handleCspReport(request: Request): Promise<Response> {
  // Reject oversized bodies before reading
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  // Rate-limit: max MAX_REPORTS_PER_MINUTE reports per IP per minute via Cache API
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const minute = Math.floor(Date.now() / 60_000);
  const cache = caches.default;
  const cacheKey = new Request(`https://csp-rate-limit/${ip}/${minute}`);
  const cached = await cache.match(cacheKey);

  if (cached) {
    const count = parseInt(await cached.text(), 10);
    if (count >= MAX_REPORTS_PER_MINUTE) {
      return new Response(null, { status: 429 });
    }
    await cache.put(
      cacheKey,
      new Response(String(count + 1), { headers: { 'Cache-Control': 'max-age=60' } })
    );
  } else {
    await cache.put(
      cacheKey,
      new Response('1', { headers: { 'Cache-Control': 'max-age=60' } })
    );
  }

  // Parse and log the report (best-effort)
  try {
    const body = await request.text();
    const parsed = JSON.parse(body);

    // Reporting API v1 sends an array of report objects
    // Legacy report-uri sends {"csp-report": {...}}
    const reports = Array.isArray(parsed)
      ? parsed.map((r: Record<string, unknown>) => (r as Record<string, Record<string, unknown>>).body ?? r)
      : [parsed['csp-report'] ?? parsed];

    for (const report of reports) {
      const truncated = {
        // Legacy (report-uri) uses hyphenated keys; Reporting API v1 uses camelCase
        'document-uri': report['document-uri'] ?? report['documentURL'],
        'violated-directive': report['violated-directive'] ?? report['violatedDirective'],
        'blocked-uri': report['blocked-uri'] ?? report['blockedURL'],
        'effective-directive': report['effective-directive'] ?? report['effectiveDirective'],
        'original-policy': report['original-policy'] ?? report['originalPolicy'],
      };
      // If all fields are undefined, log the raw report for debugging
      const hasData = Object.values(truncated).some(v => v !== undefined);
      log.info('CSP violation report', { report: hasData ? truncated : report, ip });
    }
  } catch {
    log.info('CSP violation report (unparseable)', { ip });
  }

  return new Response(null, { status: 204 });
}
