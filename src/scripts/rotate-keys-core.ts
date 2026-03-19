/**
 * Core logic for the rotation script, extracted as pure functions for testing.
 * No child_process or other Node.js-only dependencies that break in Workers runtime.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// ─── Types ───

export interface KeyEntry {
  key: string;
}

export interface CompareResult {
  action: 'use-extra' | 'generate' | 'abort';
  /** The new key hex to use for rotation (set for use-extra and generate) */
  newKeyHex?: string;
  /** Updated key list to write to disk */
  updatedKeys?: KeyEntry[];
  /** Error message when action is abort */
  error?: string;
}

// ─── Core logic functions (exported for testing) ───

/**
 * Compute fingerprint of a key hex string using SHA-256, matching the worker's
 * computeKeyFingerprint. Both hash the hex string as UTF-8 text.
 */
export function computeLocalFingerprint(keyHex: string): string {
  return createHash('sha256').update(keyHex).digest('hex').slice(0, 16);
}

/**
 * Compare local key fingerprints against remote (D1) fingerprints.
 *
 * - One extra key in local -> use it as the new key
 * - Exact match -> generate a new key and append
 * - Missing key (remote has fingerprint not in local) -> abort
 * - Multiple extra -> abort as ambiguous
 */
export function compareKeySets(
  localFingerprints: string[],
  remoteFingerprints: string[],
  localKeys: KeyEntry[]
): CompareResult {
  const localSet = new Set(localFingerprints);
  const remoteSet = new Set(remoteFingerprints);

  // Check for missing keys (remote has fingerprints not in local)
  const missing = remoteFingerprints.filter((fp) => !localSet.has(fp));
  if (missing.length > 0) {
    return {
      action: 'abort',
      error: `Local keys.json is missing fingerprints present in remote: ${missing.join(', ')}. This likely means keys.json is out of sync.`,
    };
  }

  // Find extra keys (local has fingerprints not in remote)
  const extra = localFingerprints.filter((fp) => !remoteSet.has(fp));

  if (extra.length === 0) {
    // Exact match — generate a new key
    const newKeyHex = randomBytes(32).toString('hex');
    const updatedKeys = [...localKeys, { key: newKeyHex }];
    return { action: 'generate', newKeyHex, updatedKeys };
  }

  if (extra.length === 1) {
    // One extra key — use it as the new key
    const extraFp = extra[0];
    const entry = localKeys.find((k) => computeLocalFingerprint(k.key) === extraFp);
    if (!entry) {
      return { action: 'abort', error: `Could not find key for extra fingerprint ${extraFp}` };
    }
    return { action: 'use-extra', newKeyHex: entry.key, updatedKeys: localKeys };
  }

  // Multiple extra keys — ambiguous
  return {
    action: 'abort',
    error: `Multiple extra keys in local that are not in remote: ${extra.join(', ')}. Remove extras to leave at most one new key.`,
  };
}

/**
 * Check if a file path is inside a git repository. Walks parent directories
 * looking for a .git directory. Throws if found.
 */
export function checkGitSafety(filePath: string): void {
  const absPath = resolve(filePath);
  let dir = dirname(absPath);

  while (true) {
    const gitPath = resolve(dir, '.git');
    try {
      if (existsSync(gitPath)) {
        // .git can be a directory (normal repo) or a file (submodule/worktree)
        throw new Error(
          `ABORT: ${filePath} is inside a git repository (${dir}). ` +
            'Keys files must not be stored in version control. ' +
            'Move keys.json outside the repo before proceeding.'
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('ABORT:')) throw err;
      // existsSync/statSync error — continue walking
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
}

/**
 * Validate that removing a fingerprint is safe: not the last key, and no
 * connections currently use it.
 */
export function validateRemoval(
  fingerprint: string,
  localFingerprints: string[],
  connectionCount: number
): { ok: boolean; error?: string } {
  if (!localFingerprints.includes(fingerprint)) {
    return { ok: false, error: `Fingerprint ${fingerprint} not found in keys.json` };
  }
  if (localFingerprints.length <= 1) {
    return { ok: false, error: 'Cannot remove the last remaining key' };
  }
  if (connectionCount > 0) {
    return {
      ok: false,
      error: `${connectionCount} connection(s) still use fingerprint ${fingerprint}. Rotate first, then remove.`,
    };
  }
  return { ok: true };
}
