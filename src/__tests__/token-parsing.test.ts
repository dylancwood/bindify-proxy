import { describe, it, expect } from 'vitest';
import { parseTokenResponseBody, validateTokenData, validateDecryptedTokens } from '../token-parsing';

describe('parseTokenResponseBody', () => {
  it('parses JSON response with application/json content type', () => {
    const body = JSON.stringify({
      access_token: 'gho_abc123',
      refresh_token: 'ghr_xyz789',
      expires_in: 3600,
    });
    const result = parseTokenResponseBody(body, 'application/json');
    expect(result.access_token).toBe('gho_abc123');
    expect(result.refresh_token).toBe('ghr_xyz789');
    expect(result.expires_in).toBe(3600);
  });

  it('parses form-encoded response with application/x-www-form-urlencoded content type', () => {
    const body = 'access_token=gho_abc123&refresh_token=ghr_xyz789&expires_in=3600&token_type=bearer';
    const result = parseTokenResponseBody(body, 'application/x-www-form-urlencoded');
    expect(result.access_token).toBe('gho_abc123');
    expect(result.refresh_token).toBe('ghr_xyz789');
    expect(result.expires_in).toBe(3600);
  });

  it('parses form-encoded response when content type is missing', () => {
    const body = 'access_token=gho_abc123&token_type=bearer';
    const result = parseTokenResponseBody(body, null);
    expect(result.access_token).toBe('gho_abc123');
  });

  it('parses JSON response even when content type header is missing', () => {
    const body = JSON.stringify({ access_token: 'gho_abc123' });
    const result = parseTokenResponseBody(body, null);
    expect(result.access_token).toBe('gho_abc123');
  });

  it('converts numeric string values from form-encoded to numbers for expires_in', () => {
    const body = 'access_token=tok&expires_in=7200';
    const result = parseTokenResponseBody(body, 'application/x-www-form-urlencoded');
    expect(result.expires_in).toBe(7200);
  });

  it('throws on completely unparseable body', () => {
    expect(() => parseTokenResponseBody('<<<garbage>>>', 'text/html')).toThrow();
  });

  it('throws when JSON response is not an object (array)', () => {
    expect(() => parseTokenResponseBody('["token"]', 'application/json')).toThrow();
  });

  it('throws when JSON response is null', () => {
    expect(() => parseTokenResponseBody('null', 'application/json')).toThrow();
  });

  it('throws when JSON response is a string', () => {
    expect(() => parseTokenResponseBody('"just a string"', 'application/json')).toThrow();
  });

  it('throws on form-encoded OAuth error response (e.g. GitHub bad_refresh_token)', () => {
    const body = 'error=bad_refresh_token&error_description=The+refresh+token+passed+is+incorrect+or+expired.';
    expect(() => parseTokenResponseBody(body, 'application/x-www-form-urlencoded; charset=utf-8'))
      .toThrow('OAuth error in token response: The refresh token passed is incorrect or expired.');
  });

  it('throws on JSON OAuth error response', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked' });
    expect(() => parseTokenResponseBody(body, 'application/json'))
      .toThrow('OAuth error in token response: Token has been revoked');
  });

  it('throws on form-encoded error with only error field (no description)', () => {
    const body = 'error=invalid_client';
    expect(() => parseTokenResponseBody(body, 'application/x-www-form-urlencoded'))
      .toThrow('OAuth error in token response: invalid_client');
  });

  it('does NOT throw when response has both error and access_token fields', () => {
    // Some providers include error info alongside valid tokens
    const body = 'access_token=tok_123&error=some_warning&token_type=bearer';
    const result = parseTokenResponseBody(body, 'application/x-www-form-urlencoded');
    expect(result.access_token).toBe('tok_123');
  });
});

describe('validateTokenData', () => {
  it('returns valid for complete token data', () => {
    const result = validateTokenData(
      { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
      true
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns invalid when access_token is missing', () => {
    const result = validateTokenData({ refresh_token: 'ref' }, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access_token');
  });

  it('returns invalid when access_token is empty', () => {
    const result = validateTokenData({ access_token: '', refresh_token: 'ref' }, true);
    expect(result.valid).toBe(false);
  });

  it('warns when refresh_token is missing and service requires refresh', () => {
    const result = validateTokenData(
      { access_token: 'tok', expires_in: 3600 },
      true
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('no refresh_token in token response');
  });

  it('warns when refresh_token is empty string and service requires refresh', () => {
    const result = validateTokenData(
      { access_token: 'tok', refresh_token: '', expires_in: 3600 },
      true
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('no refresh_token in token response');
  });

  it('does NOT warn about missing refresh_token when service does not require refresh', () => {
    const result = validateTokenData(
      { access_token: 'tok', expires_in: 3600 },
      false
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns keys present in the response (for logging)', () => {
    const result = validateTokenData(
      { access_token: 'tok', token_type: 'bearer', scope: 'repo' },
      false
    );
    expect(result.keysPresent).toContain('access_token');
    expect(result.keysPresent).toContain('token_type');
    expect(result.keysPresent).toContain('scope');
  });
});

describe('validateDecryptedTokens', () => {
  it('accepts valid OAuth tokens', () => {
    expect(() => validateDecryptedTokens(
      { access_token: 'tok', refresh_token: 'ref', expires_at: 123 },
      'oauth'
    )).not.toThrow();
  });

  it('accepts valid API key data', () => {
    expect(() => validateDecryptedTokens(
      { api_key: 'key123' },
      'api_key'
    )).not.toThrow();
  });

  it('rejects missing access_token for OAuth', () => {
    expect(() => validateDecryptedTokens(
      { refresh_token: 'ref', expires_at: 123 },
      'oauth'
    )).toThrow('missing or empty access_token');
  });

  it('rejects empty access_token for OAuth', () => {
    expect(() => validateDecryptedTokens(
      { access_token: '', refresh_token: 'ref', expires_at: 123 },
      'oauth'
    )).toThrow('missing or empty access_token');
  });

  it('rejects missing api_key for API key auth', () => {
    expect(() => validateDecryptedTokens(
      { some_field: 'value' },
      'api_key'
    )).toThrow('missing or empty api_key');
  });

  it('rejects empty api_key for API key auth', () => {
    expect(() => validateDecryptedTokens(
      { api_key: '' },
      'api_key'
    )).toThrow('missing or empty api_key');
  });

  it('rejects non-object input', () => {
    expect(() => validateDecryptedTokens('not an object', 'oauth')).toThrow('not an object');
  });

  it('rejects null input', () => {
    expect(() => validateDecryptedTokens(null, 'oauth')).toThrow('not an object');
  });
});
