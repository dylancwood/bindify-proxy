import { describe, it, expect } from 'vitest';
import { extractBearerToken, deriveJwksUrl } from '../auth/clerk';

describe('extractBearerToken', () => {
  it('extracts token from "Bearer abc123"', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('extracts token from "bearer abc123" (case-insensitive)', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for "Basic abc123"', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  it('returns null for null', () => {
    expect(extractBearerToken(null)).toBeNull();
  });
});

describe('deriveJwksUrl', () => {
  it('derives JWKS URL from pk_test_ key', () => {
    // pk_test_ key for settled-mosquito-25.clerk.accounts.dev
    const key = 'pk_test_c2V0dGxlZC1tb3NxdWl0by0yNS5jbGVyay5hY2NvdW50cy5kZXYk';
    expect(deriveJwksUrl(key)).toBe(
      'https://settled-mosquito-25.clerk.accounts.dev/.well-known/jwks.json'
    );
  });

  it('derives JWKS URL from pk_live_ key', () => {
    // pk_live_ key for settled-mosquito-25.clerk.accounts.dev
    const key = 'pk_live_c2V0dGxlZC1tb3NxdWl0by0yNS5jbGVyay5hY2NvdW50cy5kZXYk';
    expect(deriveJwksUrl(key)).toBe(
      'https://settled-mosquito-25.clerk.accounts.dev/.well-known/jwks.json'
    );
  });

  it('throws for invalid key prefix', () => {
    expect(() => deriveJwksUrl('pk_invalid_abc')).toThrow(
      'Invalid Clerk publishable key'
    );
  });
});
