import { describe, it, expect } from 'vitest';
import { parseConfig } from '../config';

describe('parseConfig', () => {
  it('returns defaults when CONFIG is undefined', () => {
    const config = parseConfig(undefined);
    expect(config.proxyCacheTtlSeconds).toBe(3600);
    expect(config.refreshLockTtlSeconds).toBe(3);
  });

  it('returns defaults when CONFIG is empty string', () => {
    const config = parseConfig('');
    expect(config.proxyCacheTtlSeconds).toBe(3600);
    expect(config.refreshLockTtlSeconds).toBe(3);
  });

  it('parses valid JSON and overrides defaults', () => {
    const config = parseConfig(JSON.stringify({ proxyCacheTtlSeconds: 600, refreshLockTtlSeconds: 5 }));
    expect(config.proxyCacheTtlSeconds).toBe(600);
    expect(config.refreshLockTtlSeconds).toBe(5);
  });

  it('fills in missing fields with defaults', () => {
    const config = parseConfig(JSON.stringify({ proxyCacheTtlSeconds: 900 }));
    expect(config.proxyCacheTtlSeconds).toBe(900);
    expect(config.refreshLockTtlSeconds).toBe(3);
  });

  it('returns defaults for invalid JSON', () => {
    const config = parseConfig('not-json');
    expect(config.proxyCacheTtlSeconds).toBe(3600);
    expect(config.refreshLockTtlSeconds).toBe(3);
  });
});
