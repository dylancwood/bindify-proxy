import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test logger by spying on console methods
describe('Structured Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log.info outputs JSON with level and message', async () => {
    const { log } = await import('../logger');
    log.info('test message', { handler: 'test' });
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('info');
    expect(output.message).toBe('test message');
    expect(output.handler).toBe('test');
  });

  it('log.warn outputs JSON via console.warn', async () => {
    const { log } = await import('../logger');
    log.warn('warning msg', { customerId: 'cus_123' });
    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('warn');
    expect(output.message).toBe('warning msg');
    expect(output.customerId).toBe('cus_123');
  });

  it('log.error extracts message and stack from Error', async () => {
    const { log } = await import('../logger');
    const err = new Error('boom');
    log.error('something failed', err, { handler: 'test' });
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('error');
    expect(output.message).toBe('something failed');
    expect(output.errorMessage).toBe('boom');
    expect(output.stack).toContain('Error: boom');
    expect(output.handler).toBe('test');
  });

  it('log.error handles non-Error objects', async () => {
    const { log } = await import('../logger');
    log.error('failed', 'string error');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.errorMessage).toBe('string error');
    expect(output.stack).toBeUndefined();
  });

  it('log.error works without error argument', async () => {
    const { log } = await import('../logger');
    log.error('failed');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('error');
    expect(output.message).toBe('failed');
  });
});

describe('Log Scrubbing', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts API keys matching bnd_ format', async () => {
    const { log } = await import('../logger');
    log.info('key leaked', { someField: 'bnd_abc123_def456' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.someField).toBe('bnd_[REDACTED]');
    expect(output.someField).not.toContain('abc123');
  });

  it('redacts Bearer tokens in strings', async () => {
    const { log } = await import('../logger');
    log.info('auth header leaked', { someField: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.someField).not.toContain('eyJhbGci');
    expect(output.someField).toContain('Bearer [REDACTED]');
  });

  it('redacts base64url credential-length strings (43+ chars)', async () => {
    const { log } = await import('../logger');
    // 43-char base64url string (like a secret1 or secret2)
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
    log.info('secret leaked', { someField: secret });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.someField).not.toContain(secret);
    expect(output.someField).toContain('[REDACTED:43chars]');
  });

  it('does not redact short strings', async () => {
    const { log } = await import('../logger');
    log.info('normal', { someField: 'short-value' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.someField).toBe('short-value');
  });

  it('truncates connectionId to 8 chars', async () => {
    const { log } = await import('../logger');
    log.info('connection event', { connectionId: 'abc12345-6789-full-uuid-here' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.connectionId).toBe('abc12345...');
    expect(output.connectionId).not.toContain('full-uuid');
  });

  it('preserves safe keys without scrubbing', async () => {
    const { log } = await import('../logger');
    log.info('normal log', { service: 'github', status: 200, handler: 'proxy' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.service).toBe('github');
    expect(output.status).toBe(200);
    expect(output.handler).toBe('proxy');
  });

  it('scrubs secrets from error messages', async () => {
    const { log } = await import('../logger');
    const err = new Error('Failed with token bnd_secret1_secret2');
    log.error('auth failed', err);
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.errorMessage).toContain('bnd_[REDACTED]');
    expect(output.errorMessage).not.toContain('secret1_secret2');
  });

  it('scrubs secrets from error stack traces', async () => {
    const { log } = await import('../logger');
    const err = new Error('bnd_leaked_key_here');
    log.error('stack leak', err);
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.stack).toContain('bnd_[REDACTED]');
    expect(output.stack).not.toContain('leaked_key_here');
  });

  it('scrubs nested objects recursively', async () => {
    const { log } = await import('../logger');
    log.info('nested', { outer: { inner: 'bnd_secret_value' } });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.outer.inner).toBe('bnd_[REDACTED]');
  });

  it('handles 86-char credential blobs', async () => {
    const { log } = await import('../logger');
    const cred86 = 'A'.repeat(86);
    log.info('cred leaked', { someField: cred86 });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.someField).not.toContain(cred86);
    expect(output.someField).toContain('[REDACTED:86chars]');
  });

  it('handles null and undefined values', async () => {
    const { log } = await import('../logger');
    log.info('nulls', { nullVal: null, undefVal: undefined });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.nullVal).toBeNull();
  });

  it('handles numeric values without scrubbing', async () => {
    const { log } = await import('../logger');
    log.info('numbers', { count: 42, ratio: 3.14 });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.count).toBe(42);
    expect(output.ratio).toBe(3.14);
  });
});

describe('scrubContext (exported)', () => {
  it('is exported for direct use', async () => {
    const { scrubContext } = await import('../logger');
    const result = scrubContext({ key: 'bnd_test_secret' });
    expect(result.key).toBe('bnd_[REDACTED]');
  });
});
