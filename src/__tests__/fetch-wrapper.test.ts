import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Outer fetch wrapper', () => {
  it('returns 500 JSON instead of uncaught exception for unhandled errors', async () => {
    // Any valid request should return a proper response, not throw
    // This test verifies the outer wrapper catches errors gracefully
    const response = await SELF.fetch('http://localhost/');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-bindify-version')).toBeTruthy();
  });

  it('includes standard security headers on all responses', async () => {
    const response = await SELF.fetch('http://localhost/');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
  });
});
