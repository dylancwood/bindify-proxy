import type { TokenData, ApiKeyData } from '@bindify/types';
import { log } from './logger';

/**
 * Defensively parses a token endpoint response body.
 * Handles both JSON and application/x-www-form-urlencoded formats.
 */
export function parseTokenResponseBody(
  body: string,
  contentType: string | null
): Record<string, any> {
  const isFormEncoded = contentType?.includes('application/x-www-form-urlencoded');

  if (isFormEncoded) {
    return parseFormEncoded(body);
  }

  // Try JSON first (most common with Accept: application/json)
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Token response JSON is not an object');
    }
    // Detect OAuth error responses returned as 200 with JSON body
    if (parsed.error && !parsed.access_token) {
      const desc = parsed.error_description || parsed.error;
      throw new Error(`OAuth error in token response: ${desc}`);
    }
    return parsed;
  } catch (err) {
    // Re-throw OAuth errors and validation errors (not JSON parse failures)
    if (err instanceof Error && (err.message.startsWith('OAuth error') || err.message.startsWith('Token response JSON'))) {
      throw err;
    }
    // Fallback: try form-encoded in case provider ignored Accept header
    try {
      const parsed = parseFormEncoded(body);
      // Sanity check: form-encoded should have at least access_token
      if (parsed.access_token) return parsed;
    } catch (formErr) {
      if (formErr instanceof Error && formErr.message.startsWith('OAuth error')) {
        throw formErr;
      }
      // Log unexpected parsing errors but don't block — fall through to final throw
      log.warn('Unexpected error parsing form-encoded response', { error: formErr instanceof Error ? formErr.message : String(formErr) });
    }
    throw new Error(`Unable to parse token response body (content-type: ${contentType})`);
  }
}

function parseFormEncoded(body: string): Record<string, any> {
  const params = new URLSearchParams(body);
  const result: Record<string, any> = {};
  for (const [key, value] of params) {
    // Convert numeric values for known numeric fields
    if (key === 'expires_in' || key === 'refresh_token_expires_in') {
      const num = parseInt(value, 10);
      result[key] = isNaN(num) ? value : num;
    } else {
      result[key] = value;
    }
  }

  // Detect OAuth error responses returned as 200 with form-encoded body
  // (e.g. GitHub returns error=bad_refresh_token with HTTP 200)
  if (result.error && !result.access_token) {
    const desc = result.error_description || result.error;
    throw new Error(`OAuth error in token response: ${desc}`);
  }

  return result;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
  keysPresent: string[];
}

/**
 * Validates parsed token response data.
 * Returns validation result with warnings for non-fatal issues.
 */
export function validateTokenData(
  data: Record<string, any>,
  requiresRefresh: boolean
): ValidationResult {
  const keysPresent = Object.keys(data);
  const warnings: string[] = [];

  if (!data.access_token) {
    return {
      valid: false,
      error: 'Missing or empty access_token in token response',
      warnings,
      keysPresent,
    };
  }

  if (requiresRefresh && (!data.refresh_token || data.refresh_token === '')) {
    warnings.push('no refresh_token in token response');
  }

  return { valid: true, warnings, keysPresent };
}

/**
 * Validates decrypted token data has the expected shape.
 * Defense-in-depth against historically-corrupted data.
 * Throws on invalid data — callers should catch and handle.
 */
export function validateDecryptedTokens(
  parsed: unknown,
  authType: 'oauth' | 'api_key'
): asserts parsed is TokenData | ApiKeyData {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Decrypted token data is not an object');
  }
  if (authType === 'api_key') {
    if (!('api_key' in parsed) || typeof (parsed as any).api_key !== 'string' || !(parsed as any).api_key) {
      throw new Error('Decrypted API key data missing or empty api_key');
    }
  } else {
    if (!('access_token' in parsed) || typeof (parsed as any).access_token !== 'string' || !(parsed as any).access_token) {
      throw new Error('Decrypted token data missing or empty access_token');
    }
  }
}
