/**
 * Clerk JWT verification utilities for Cloudflare Workers.
 *
 * Verifies Clerk-issued JWTs using JWKS (JSON Web Key Sets) with
 * RSA signature validation via the Web Crypto API.
 */

import { log } from '../logger';

// Module-level JWKS cache
let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Derives the JWKS URL from a Clerk publishable key.
 *
 * Clerk publishable keys encode the instance domain as base64url:
 *   pk_test_{base64(instance-slug.clerk.accounts.dev$)}
 *   pk_live_{base64(instance-slug.clerk.accounts.dev$)}
 *
 * This eliminates the need for a separate CLERK_JWKS_URL configuration,
 * preventing mismatches between the frontend publishable key and backend JWKS URL.
 */
export function deriveJwksUrl(publishableKey: string): string {
  // Strip the pk_test_ or pk_live_ prefix
  const prefix = publishableKey.startsWith('pk_test_')
    ? 'pk_test_'
    : publishableKey.startsWith('pk_live_')
      ? 'pk_live_'
      : null;
  if (!prefix) {
    throw new Error('Invalid Clerk publishable key: must start with pk_test_ or pk_live_');
  }
  const encoded = publishableKey.slice(prefix.length);
  // Base64url decode
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const domain = atob(base64).replace(/\$$/, ''); // Remove trailing $
  return `https://${domain}/.well-known/jwks.json`;
}

/**
 * Extracts a Bearer token from an Authorization header value.
 * Case-insensitive match on "Bearer".
 */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Base64url decode to Uint8Array.
 */
export function base64UrlDecode(input: string): Uint8Array {
  // Replace base64url chars with base64 chars and pad
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode and parse a JWT header (first segment).
 */
export function decodeJwtHeader(token: string): { alg: string; kid: string; typ?: string } {
  const [headerB64] = token.split('.');
  if (!headerB64) throw new Error('Invalid JWT: missing header');
  const decoded = new TextDecoder().decode(base64UrlDecode(headerB64));
  return JSON.parse(decoded);
}

/**
 * Decode and parse a JWT payload (second segment).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (!parts[1]) throw new Error('Invalid JWT: missing payload');
  const decoded = new TextDecoder().decode(base64UrlDecode(parts[1]));
  return JSON.parse(decoded);
}

interface JwksKey {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

/**
 * Fetches JWKS from the given URL, with 1-hour module-level caching.
 */
async function fetchJwks(jwksUrl: string): Promise<JwksKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys as unknown as JwksKey[];
  }

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const data = (await response.json()) as JwksResponse;
  jwksCache = { keys: data.keys as unknown as JsonWebKey[], fetchedAt: now };
  return data.keys;
}

/**
 * Verifies a Clerk JWT token against a JWKS endpoint.
 *
 * Steps:
 * 1. Decode JWT header to get `kid`
 * 2. Fetch JWKS (cached for 1 hour)
 * 3. Find the matching key by `kid`
 * 4. Import as RSA-OAEP/RSASSA-PKCS1-v1_5 key and verify signature
 * 5. Check expiration
 * 6. Return `{ userId: sub }` or null
 */
export async function verifyClerkToken(
  token: string,
  jwksUrl: string
): Promise<{ userId: string } | null> {
  try {
    // Decode header to get kid
    const header = decodeJwtHeader(token);
    if (!header.kid) {
      log.warn('JWT verification failed: missing kid in header');
      return null;
    }

    // Fetch JWKS and find matching key
    const keys = await fetchJwks(jwksUrl);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      log.warn('JWT verification failed: no matching key for kid', {
        kid: header.kid,
        availableKids: keys.map((k) => k.kid),
        jwksUrl,
      });
      return null;
    }

    // Import the public key for verification
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        alg: 'RS256',
        ext: true,
      },
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );

    // Verify signature
    const parts = token.split('.');
    const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlDecode(parts[2]);

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      signatureInput
    );

    if (!valid) {
      log.warn('JWT verification failed: signature invalid', { kid: header.kid });
      return null;
    }

    // Check expiration
    const payload = decodeJwtPayload(token);
    const exp = payload.exp as number | undefined;
    if (exp && exp < Math.floor(Date.now() / 1000)) {
      log.warn('JWT verification failed: token expired', { exp });
      return null;
    }

    // Return user ID from sub claim
    const sub = payload.sub as string | undefined;
    if (!sub) {
      log.warn('JWT verification failed: missing sub claim');
      return null;
    }

    return { userId: sub };
  } catch (err) {
    log.error('JWT verification error', err, { jwksUrl });
    return null;
  }
}

/**
 * Clears the JWKS cache. Useful for testing.
 */
export function clearJwksCache(): void {
  jwksCache = null;
}
