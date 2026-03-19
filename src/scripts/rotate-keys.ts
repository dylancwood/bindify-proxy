/**
 * Key rotation migration script.
 *
 * Re-encrypts all managed connections from an old master key version to a new one.
 * Also updates KV cache entries in place.
 *
 * Usage: Run as a Wrangler script with both old and new keys in MANAGED_ENCRYPTION_KEYS.
 *
 * Idempotent: safe to re-run (skips already-migrated connections via key_version filter).
 */

import type { ManagedKeyEntry } from '../crypto';
import {
  parseManagedKeys,
  getManagedKey,
  getActiveKey,
  deriveManagedEncryptionKey,
  decryptTokenDataWithKey,
  encryptTokenDataWithKey,
} from '../crypto';
import type { ProxyCacheEntry } from '../proxy/kv-cache';

interface RotateKeysEnv {
  DB: D1Database;
  KV: KVNamespace;
  MANAGED_ENCRYPTION_KEYS: string;
}

export async function rotateKeys(env: RotateKeysEnv): Promise<{ migrated: number; errors: string[] }> {
  const keys = await parseManagedKeys(env.MANAGED_ENCRYPTION_KEYS);
  const active = getActiveKey(keys);
  // TODO: This script will be fully rewritten in Task 12 for fingerprint-based rotation
  const targetVersion = 0; // placeholder — script is non-functional until Task 12 rewrite

  const connections = await env.DB
    .prepare(
      `SELECT id, secret_url_segment_1, encrypted_tokens, dcr_registration, key_version
       FROM connections
       WHERE key_storage_mode = 'managed' AND key_version < ?`
    )
    .bind(targetVersion)
    .all<{
      id: string;
      secret_url_segment_1: string;
      encrypted_tokens: string | null;
      dcr_registration: string | null;
      key_version: number;
    }>();

  let migrated = 0;
  const errors: string[] = [];

  for (const conn of connections.results) {
    try {
      const oldMasterKey = getManagedKey(keys, conn.key_version);
      const newMasterKey = active.key;

      // Derive old and new per-connection keys once (same for tokens and DCR)
      const oldKey = await deriveManagedEncryptionKey(oldMasterKey, conn.id);
      const newKey = await deriveManagedEncryptionKey(newMasterKey, conn.id);

      // Re-encrypt tokens
      let newEncryptedTokens: string | null = null;
      if (conn.encrypted_tokens) {
        const decrypted = await decryptTokenDataWithKey(conn.encrypted_tokens, oldKey);
        newEncryptedTokens = await encryptTokenDataWithKey(decrypted, newKey);
      }

      // Re-encrypt DCR registration
      let newDcrRegistration: string | null = null;
      if (conn.dcr_registration) {
        const decrypted = await decryptTokenDataWithKey(conn.dcr_registration, oldKey);
        newDcrRegistration = await encryptTokenDataWithKey(decrypted, newKey);
      }

      // Update D1
      await env.DB
        .prepare(
          'UPDATE connections SET encrypted_tokens = ?, dcr_registration = ?, key_version = ? WHERE id = ?'
        )
        .bind(
          newEncryptedTokens ?? conn.encrypted_tokens,
          newDcrRegistration ?? conn.dcr_registration,
          targetVersion,
          conn.id
        )
        .run();

      // Update KV cache entry in place
      const kvKey = `proxy:${conn.secret_url_segment_1}`;
      const kvRaw = await env.KV.get(kvKey);
      if (kvRaw) {
        try {
          const entry = JSON.parse(kvRaw) as ProxyCacheEntry;
          if (newEncryptedTokens) {
            entry.encryptedTokens = newEncryptedTokens;
          }
          if (newDcrRegistration) {
            entry.dcrRegistration = newDcrRegistration;
          }
          entry.keyVersion = targetVersion;
          await env.KV.put(kvKey, JSON.stringify(entry));
        } catch {
          // KV entry corrupt or missing — skip, will be rebuilt on next use
        }
      }

      migrated++;
      console.log(`Migrated connection ${conn.id} from v${conn.key_version} to v${targetVersion}`);
    } catch (err) {
      const msg = `Failed to migrate ${conn.id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(msg);
    }
  }

  console.log(`\nRotation complete: ${migrated} migrated, ${errors.length} errors`);
  return { migrated, errors };
}
