import { describe, it, expect } from 'vitest';
import { getCallbackUrl } from '../utils/url';

describe('getCallbackUrl', () => {
  it('derives production callback URL from ADMIN_URL', () => {
    const env = { ADMIN_URL: 'https://app.bindify.dev' } as any;
    expect(getCallbackUrl(env)).toBe('https://api.bindify.dev/api/connections/callback');
  });

  it('derives staging callback URL from ADMIN_URL', () => {
    const env = { ADMIN_URL: 'https://app.stg.bindify.dev' } as any;
    expect(getCallbackUrl(env)).toBe('https://api.stg.bindify.dev/api/connections/callback');
  });

  it('handles comma-separated ADMIN_URL (uses first)', () => {
    const env = { ADMIN_URL: 'https://app.bindify.dev, https://localhost:3000' } as any;
    expect(getCallbackUrl(env)).toBe('https://api.bindify.dev/api/connections/callback');
  });
});
