import { describe, it, expect } from 'vitest';
import { categorizeAuthError } from '../proxy/auth-errors';

describe('categorizeAuthError', () => {
  it('categorizes "Session not found" as auth/kv_miss', () => {
    const result = categorizeAuthError(new Error('Session not found'));
    expect(result.eventType).toBe('auth');
    expect(result.category).toBe('kv_miss');
  });

  it('categorizes decryption errors as auth/decryption_failed', () => {
    const result = categorizeAuthError(new Error('The operation failed for an operation-specific reason'));
    expect(result.eventType).toBe('auth');
    expect(result.category).toBe('decryption_failed');
  });

  it('categorizes generic token refresh failure as token_refresh/refresh_failed', () => {
    const result = categorizeAuthError(new Error('Token refresh failed: 500 Internal Server Error'));
    expect(result.eventType).toBe('token_refresh');
    expect(result.category).toBe('refresh_failed');
    expect(result.upstreamStatus).toBe(500);
  });

  it('categorizes invalid_grant errors as token_refresh/invalid_grant', () => {
    const result = categorizeAuthError(new Error('Token refresh failed: 401 {"error":"invalid_grant"}'));
    expect(result.eventType).toBe('token_refresh');
    expect(result.category).toBe('invalid_grant');
  });

  it('categorizes invalid_client errors as token_refresh/invalid_grant', () => {
    const result = categorizeAuthError(new Error('Token refresh failed: 400 {"error":"invalid_client"}'));
    expect(result.eventType).toBe('token_refresh');
    expect(result.category).toBe('invalid_grant');
  });

  it('categorizes unknown errors as auth/unknown', () => {
    const result = categorizeAuthError(new Error('Something completely unexpected'));
    expect(result.eventType).toBe('auth');
    expect(result.category).toBe('unknown');
  });

  it('handles non-Error objects', () => {
    const result = categorizeAuthError('string error');
    expect(result.eventType).toBe('auth');
    expect(result.category).toBe('unknown');
  });

  it('extracts upstream status from refresh failure message', () => {
    const result = categorizeAuthError(new Error('Token refresh failed: 500 Internal Server Error'));
    expect(result.upstreamStatus).toBe(500);
  });
});
