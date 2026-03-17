import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowlisted } from '../bot-detection/allowlist';

describe('parseAllowlist', () => {
  it('parses comma-separated IPs', () => {
    const result = parseAllowlist('1.2.3.4,5.6.7.8');
    expect(result.has('1.2.3.4')).toBe(true);
    expect(result.has('5.6.7.8')).toBe(true);
  });

  it('trims whitespace', () => {
    const result = parseAllowlist(' 1.2.3.4 , 5.6.7.8 ');
    expect(result.has('1.2.3.4')).toBe(true);
    expect(result.has('5.6.7.8')).toBe(true);
  });

  it('returns empty set for undefined/empty', () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist('').size).toBe(0);
  });

  it('ignores empty entries from trailing commas', () => {
    const result = parseAllowlist('1.2.3.4,,5.6.7.8,');
    expect(result.size).toBe(2);
  });
});

describe('isAllowlisted', () => {
  it('returns true for IPs in the set', () => {
    const set = new Set(['1.2.3.4']);
    expect(isAllowlisted(set, '1.2.3.4')).toBe(true);
  });

  it('returns false for IPs not in the set', () => {
    const set = new Set(['1.2.3.4']);
    expect(isAllowlisted(set, '9.9.9.9')).toBe(false);
  });

  it('returns false for empty set', () => {
    expect(isAllowlisted(new Set(), '1.2.3.4')).toBe(false);
  });
});
