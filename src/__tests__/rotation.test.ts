import { describe, it, expect, vi } from 'vitest';
import { detectOrphanedFingerprints } from '../rotation';

describe('detectOrphanedFingerprints', () => {
  it('logs error when D1 has fingerprint not in config', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: 'orphaned1234abcd' }],
        }),
      }),
    };
    const configFingerprints = ['configured12345a'];
    const logger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, configFingerprints, logger as any);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('orphaned1234abcd')
    );
  });

  it('does not log when all fingerprints match', async () => {
    const fp = 'configured12345a';
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: fp }],
        }),
      }),
    };
    const logger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, [fp], logger as any);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('ignores empty key_fingerprint rows (ZK connections)', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [{ key_fingerprint: '' }],
        }),
      }),
    };
    const logger = { error: vi.fn(), info: vi.fn() };

    await detectOrphanedFingerprints(mockDb as any, ['configured12345a'], logger as any);

    expect(logger.error).not.toHaveBeenCalled();
  });
});
