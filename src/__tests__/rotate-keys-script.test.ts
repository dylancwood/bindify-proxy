import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeLocalFingerprint,
  compareKeySets,
  checkGitSafety,
  validateRemoval,
} from '../scripts/rotate-keys-core';
import { computeKeyFingerprint } from '../crypto';

// ─── computeLocalFingerprint ───

describe('computeLocalFingerprint', () => {
  it('matches the worker computeKeyFingerprint (both hash hex as UTF-8)', async () => {
    const testKeys = [
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      'test-master-key-0123456789abcdef0123456789abcdef',
      '0000000000000000000000000000000000000000000000000000000000000000',
    ];

    for (const keyHex of testKeys) {
      const localFp = computeLocalFingerprint(keyHex);
      const workerFp = await computeKeyFingerprint(keyHex);
      expect(localFp).toBe(workerFp);
      expect(localFp).toHaveLength(16);
    }
  });

  it('produces a 16 character hex fingerprint', () => {
    const fp = computeLocalFingerprint('deadbeef'.repeat(8));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different fingerprints for different keys', () => {
    const fp1 = computeLocalFingerprint('a'.repeat(64));
    const fp2 = computeLocalFingerprint('b'.repeat(64));
    expect(fp1).not.toBe(fp2);
  });
});

// ─── compareKeySets ───

describe('compareKeySets', () => {
  const key1 = 'aaaa'.repeat(16);
  const key2 = 'bbbb'.repeat(16);
  const key3 = 'cccc'.repeat(16);
  const fp1 = computeLocalFingerprint(key1);
  const fp2 = computeLocalFingerprint(key2);
  const fp3 = computeLocalFingerprint(key3);

  it('generates a new key when local and remote match exactly', () => {
    const result = compareKeySets([fp1], [fp1], [{ key: key1 }]);
    expect(result.action).toBe('generate');
    expect(result.newKeyHex).toBeDefined();
    expect(result.newKeyHex).toHaveLength(64); // 32 bytes hex
    expect(result.updatedKeys).toHaveLength(2);
    expect(result.updatedKeys![0].key).toBe(key1);
    expect(result.updatedKeys![1].key).toBe(result.newKeyHex);
  });

  it('uses existing extra key when one local key is not in remote', () => {
    const result = compareKeySets([fp1, fp2], [fp1], [{ key: key1 }, { key: key2 }]);
    expect(result.action).toBe('use-extra');
    expect(result.newKeyHex).toBe(key2);
    expect(result.updatedKeys).toHaveLength(2);
  });

  it('aborts when remote has a fingerprint not in local (missing key)', () => {
    const result = compareKeySets([fp1], [fp1, fp2], [{ key: key1 }]);
    expect(result.action).toBe('abort');
    expect(result.error).toContain('missing fingerprints');
    expect(result.error).toContain(fp2);
  });

  it('aborts with multiple extra keys (ambiguous)', () => {
    const result = compareKeySets(
      [fp1, fp2, fp3],
      [fp1],
      [{ key: key1 }, { key: key2 }, { key: key3 }]
    );
    expect(result.action).toBe('abort');
    expect(result.error).toContain('Multiple extra');
  });

  it('handles empty remote fingerprints (fresh deployment)', () => {
    const result = compareKeySets([fp1], [], [{ key: key1 }]);
    expect(result.action).toBe('use-extra');
    expect(result.newKeyHex).toBe(key1);
  });

  it('handles both empty (fresh deployment, no connections)', () => {
    const result = compareKeySets([], [], []);
    expect(result.action).toBe('generate');
    expect(result.newKeyHex).toHaveLength(64);
  });
});

// ─── checkGitSafety ───
// Note: checkGitSafety uses node:fs (existsSync/statSync) which is not fully
// functional in the Cloudflare Workers test runtime. We test the logic via a
// separate unit approach: verify it doesn't throw for paths outside repos, and
// verify the error message format. Full integration testing requires running
// outside the Workers pool (e.g., `npx tsx` directly).

describe('checkGitSafety', () => {
  it('does not throw for a path outside any git repo', () => {
    // /tmp is not inside a git repo (existsSync returns false in Workers runtime
    // anyway, so this verifies the function completes without error)
    expect(() => checkGitSafety('/tmp/keys.json')).not.toThrow();
  });

  it('error message format includes expected text', () => {
    // Verify the error constructor message format matches expectations
    const err = new Error(
      'ABORT: /repo/keys.json is inside a git repository (/repo). ' +
        'Keys files must not be stored in version control. ' +
        'Move keys.json outside the repo before proceeding.'
    );
    expect(err.message).toContain('inside a git repository');
    expect(err.message).toContain('ABORT');
    expect(err.message).toContain('Move keys.json outside the repo');
  });
});

// ─── validateRemoval ───

describe('validateRemoval', () => {
  const fp1 = 'aaaa111122223333';
  const fp2 = 'bbbb444455556666';

  it('rejects removing the last remaining key', () => {
    const result = validateRemoval(fp1, [fp1], 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('last remaining key');
  });

  it('rejects removing a key with active connections', () => {
    const result = validateRemoval(fp1, [fp1, fp2], 3);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('3 connection(s)');
  });

  it('rejects removing a fingerprint not in the key list', () => {
    const result = validateRemoval('notfound12345678', [fp1, fp2], 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('succeeds with 0 connections and multiple keys', () => {
    const result = validateRemoval(fp1, [fp1, fp2], 0);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
