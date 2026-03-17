import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkProxyRateLimit } from '../proxy/handler';

describe('checkProxyRateLimit', () => {
  beforeEach(async () => {
    const list = await env.KV.list({ prefix: 'ratelimit:' });
    for (const key of list.keys) {
      await env.KV.delete(key.name);
    }
  });

  it('returns null when rate limit env var is not set', async () => {
    const result = await checkProxyRateLimit(
      { KV: env.KV } as any,
      'conn-123',
      undefined
    );
    expect(result).toBeNull();
  });

  it('returns null when under the limit', async () => {
    const result = await checkProxyRateLimit(
      { KV: env.KV } as any,
      'conn-123',
      '100'
    );
    expect(result).toBeNull();
  });

  it('returns 429 response when limit is exceeded', async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `ratelimit:conn-456:${hourBucket}`;
    await env.KV.put(key, '100');

    const result = await checkProxyRateLimit(
      { KV: env.KV } as any,
      'conn-456',
      '100'
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);

    const body = await result!.json() as any;
    expect(body.error).toBe('rate_limited');
  });

  it('increments the counter on each call', async () => {
    await checkProxyRateLimit({ KV: env.KV } as any, 'conn-789', '100');
    await checkProxyRateLimit({ KV: env.KV } as any, 'conn-789', '100');
    await checkProxyRateLimit({ KV: env.KV } as any, 'conn-789', '100');

    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `ratelimit:conn-789:${hourBucket}`;
    const value = await env.KV.get(key);
    expect(value).toBe('3');
  });
});
