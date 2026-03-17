// Pattern: bnd_{secret1}_{secret2} API keys
const API_KEY_PATTERN = /\bbnd_[A-Za-z0-9_-]+/g;

// Pattern: Bearer tokens in strings (e.g. from error messages)
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]{20,}/gi;

// Pattern: base64url strings of credential length (43+ chars, typical for secret1/secret2/credentials)
const BASE64URL_CREDENTIAL_PATTERN = /\b[A-Za-z0-9_-]{43,}\b/g;

// Keys whose values should never be scrubbed (known safe context fields)
const SAFE_KEYS = new Set([
  'level', 'message', 'timestamp', 'handler', 'service', 'serviceId',
  'eventType', 'status', 'error', 'category', 'detail', 'method', 'path',
  'cron', 'count', 'refreshedCount', 'removedCount', 'toolCount',
  'upstreamStatus', 'urlSegment', 'ip', 'prefix', 'kid',
  'plan', 'trialEndsAt', 'accessUntil', 'subscriptionStatus',
  'exp', 'sessionId',
]);

// Keys that contain sensitive values and should always be fully redacted
const SENSITIVE_KEYS = new Set([
  'stack', 'errorMessage',
]);

function scrubString(value: string): string {
  let scrubbed = value.replace(API_KEY_PATTERN, 'bnd_[REDACTED]');
  scrubbed = scrubbed.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  scrubbed = scrubbed.replace(BASE64URL_CREDENTIAL_PATTERN, (match) => {
    // Only redact long base64url strings (43+ chars = 32+ bytes encoded)
    // Short strings like UUIDs, service names, etc. are fine
    if (match.length >= 43) {
      return `[REDACTED:${match.length}chars]`;
    }
    return match;
  });
  return scrubbed;
}

function scrubConnectionId(value: string): string {
  // Truncate connection IDs to first 8 chars for log correlation without full exposure
  if (value.length > 8) {
    return value.slice(0, 8) + '...';
  }
  return value;
}

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (depth > 5) return '[TRUNCATED]';

  if (key === 'connectionId' && typeof value === 'string') {
    return scrubConnectionId(value);
  }

  if (SAFE_KEYS.has(key)) {
    return value;
  }

  if (SENSITIVE_KEYS.has(key) && typeof value === 'string') {
    return scrubString(value);
  }

  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(String(i), item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scrubbed[k] = scrubValue(k, v, depth + 1);
    }
    return scrubbed;
  }

  return value;
}

export function scrubContext(context: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    scrubbed[key] = scrubValue(key, value, 0);
  }
  return scrubbed;
}

function formatLog(level: string, message: string, context?: Record<string, unknown>): string {
  const scrubbedContext = context ? scrubContext(context) : undefined;
  return JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...scrubbedContext });
}

export const log = {
  info(message: string, context?: Record<string, unknown>): void {
    console.log(formatLog('info', message, context));
  },

  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(formatLog('warn', message, context));
  },

  error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    const errorContext: Record<string, unknown> = { ...context };
    if (error instanceof Error) {
      errorContext.errorMessage = error.message;
      errorContext.stack = error.stack;
    } else if (error !== undefined) {
      errorContext.errorMessage = String(error);
    }
    console.error(formatLog('error', message, errorContext));
  },
};
