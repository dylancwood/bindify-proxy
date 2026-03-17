import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlocklistCache } from '../bot-detection/blocklist-cache';

describe('BlocklistCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns null on cache miss (triggers KV lookup)', () => {
    const cache = new BlocklistCache(30000);
    expect(cache.get('1.2.3.4')).toBeNull();
  });

  it('caches blocked=true result', () => {
    const cache = new BlocklistCache(30000);
    cache.set('1.2.3.4', true);
    expect(cache.get('1.2.3.4')).toBe(true);
  });

  it('caches blocked=false result (negative cache)', () => {
    const cache = new BlocklistCache(30000);
    cache.set('1.2.3.4', false);
    expect(cache.get('1.2.3.4')).toBe(false);
  });

  it('returns null after TTL expires', () => {
    const cache = new BlocklistCache(30000);
    cache.set('1.2.3.4', true);
    expect(cache.get('1.2.3.4')).toBe(true);

    vi.advanceTimersByTime(30001);
    expect(cache.get('1.2.3.4')).toBeNull();
  });

  it('uses configurable TTL', () => {
    const cache = new BlocklistCache(5000);
    cache.set('1.2.3.4', true);

    vi.advanceTimersByTime(4999);
    expect(cache.get('1.2.3.4')).toBe(true);

    vi.advanceTimersByTime(2);
    expect(cache.get('1.2.3.4')).toBeNull();
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = new BlocklistCache(30000, 3);
    cache.set('1.1.1.1', true);
    cache.set('2.2.2.2', false);
    cache.set('3.3.3.3', true);

    // Adding a 4th should evict 1.1.1.1 (oldest)
    cache.set('4.4.4.4', true);

    expect(cache.get('1.1.1.1')).toBeNull(); // evicted
    expect(cache.get('2.2.2.2')).toBe(false); // still there
    expect(cache.get('3.3.3.3')).toBe(true);  // still there
    expect(cache.get('4.4.4.4')).toBe(true);  // newly added
  });

  it('does not evict when updating an existing key', () => {
    const cache = new BlocklistCache(30000, 2);
    cache.set('1.1.1.1', true);
    cache.set('2.2.2.2', false);

    // Updating existing key should not evict
    cache.set('1.1.1.1', false);

    expect(cache.get('1.1.1.1')).toBe(false);
    expect(cache.get('2.2.2.2')).toBe(false);
  });
});
