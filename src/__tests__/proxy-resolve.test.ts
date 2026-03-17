import { describe, it, expect } from 'vitest';
import { parseApiKey } from '../proxy/resolve';

describe('parseApiKey', () => {
  it('parses valid API key format bnd_{env}_{credentials}', () => {
    const creds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFGHIJKLMNOPQRSTUV';
    const result = parseApiKey(`bnd_live_${creds}`);
    expect(result).not.toBeNull();
    expect(result!.credentials).toBe(creds);
  });

  it('parses all environment prefixes', () => {
    const creds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFGHIJKLMNOPQRSTUV';
    expect(parseApiKey(`bnd_live_${creds}`)).not.toBeNull();
    expect(parseApiKey(`bnd_stg_${creds}`)).not.toBeNull();
    expect(parseApiKey(`bnd_test_${creds}`)).not.toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(parseApiKey('invalid')).toBeNull();
    expect(parseApiKey('bnd_live_tooshort')).toBeNull();
    expect(parseApiKey('bnd_unknown_' + 'A'.repeat(86))).toBeNull();
  });
});

