import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Worker smoke test', () => {
  it('returns 404 for unknown routes', async () => {
    const response = await SELF.fetch('http://localhost/unknown');
    expect(response.status).toBe(404);
  });
});
