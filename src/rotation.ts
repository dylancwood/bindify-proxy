import type { D1Database } from '@cloudflare/workers-types';
import {
  deriveManagedEncryptionKey,
  encryptTokenDataWithKey,
  decryptTokenDataWithKey,
  getManagedKey,
  getActiveKey,
} from './crypto';
import type { ManagedKeyEntry } from './crypto';

interface PendingKeyRotation {
  id: number;
  expected_fingerprints: string;
  new_key_hex: string;
  new_key_fingerprint: string;
  status: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface ManagedConnection {
  id: string;
  secret_url_segment_1: string;
  encrypted_tokens: string | null;
  managed_key_fingerprint: string;
  dcr_registration: string | null;
}

export async function processRotationRequests(
  db: D1Database,
  kv: KVNamespace,
  configKeys: ManagedKeyEntry[],
  logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
): Promise<void> {
  // Phase 1: Validate pending requests
  await validatePendingRequest(db, configKeys, logger);

  // Phase 2: Execute migration
  await executeMigration(db, kv, configKeys, logger);

  // Phase 3: Cleanup old rows
  await db
    .prepare(
      "DELETE FROM pending_key_rotations WHERE status IN ('completed', 'failed', 'rejected') AND created_at < datetime('now', '-30 days')"
    )
    .run();
}

async function validatePendingRequest(
  db: D1Database,
  configKeys: ManagedKeyEntry[],
  logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT * FROM pending_key_rotations WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
    )
    .first<PendingKeyRotation>();

  if (!row) {
    logger.info('No pending rotation requests');
    return;
  }

  logger.info('Processing pending rotation request', { id: row.id, status: row.status });
  const configFingerprints = configKeys.map((k) => k.fingerprint);
  let expectedFingerprints: string[];
  try {
    expectedFingerprints = JSON.parse(row.expected_fingerprints);
  } catch {
    await db
      .prepare(
        "UPDATE pending_key_rotations SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(
        JSON.stringify({ phase: 'validation', error: 'Invalid expected_fingerprints JSON' }),
        row.id
      )
      .run();
    return;
  }

  // Check if fingerprints match
  const configSorted = [...configFingerprints].sort();
  const expectedSorted = [...expectedFingerprints].sort();
  if (
    configSorted.length !== expectedSorted.length ||
    configSorted.some((fp, i) => fp !== expectedSorted[i])
  ) {
    await db
      .prepare(
        "UPDATE pending_key_rotations SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(
        JSON.stringify({
          phase: 'validation',
          error: 'Fingerprint mismatch',
          expected: expectedFingerprints,
          actual: configFingerprints,
        }),
        row.id
      )
      .run();
    logger.error(
      `Rotation ${row.id}: fingerprint mismatch. Expected: ${JSON.stringify(expectedFingerprints)}, Actual: ${JSON.stringify(configFingerprints)}`
    );
    return;
  }

  // Check if new key fingerprint already exists in config
  if (configFingerprints.includes(row.new_key_fingerprint)) {
    await db
      .prepare(
        "UPDATE pending_key_rotations SET status = 'rejected', result = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(
        JSON.stringify({
          phase: 'validation',
          error: 'New key fingerprint already exists in config',
          fingerprint: row.new_key_fingerprint,
        }),
        row.id
      )
      .run();
    return;
  }

  // Validated
  await db
    .prepare(
      "UPDATE pending_key_rotations SET status = 'validated', result = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(
      JSON.stringify({
        phase: 'validated',
        message: 'Fingerprints match. Proceed with wrangler secret put.',
      }),
      row.id
    )
    .run();
}

async function executeMigration(
  db: D1Database,
  kv: KVNamespace,
  configKeys: ManagedKeyEntry[],
  logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT * FROM pending_key_rotations WHERE status = 'migrate' ORDER BY id ASC LIMIT 1"
    )
    .first<PendingKeyRotation>();

  if (!row) {
    logger.info('No migrate rotation requests');
    return;
  }

  logger.info('Processing migrate rotation request', { id: row.id });
  const activeKey = getActiveKey(configKeys);
  const activeFingerprint = activeKey.fingerprint;

  // Mark as in_progress
  await db
    .prepare(
      "UPDATE pending_key_rotations SET status = 'in_progress', result = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(JSON.stringify({ phase: 'migrating', message: 'Querying connections to migrate...' }), row.id)
    .run();

  // Phase 1: Query managed connections whose tokens need migration
  const connections = await db
    .prepare(
      "SELECT id, secret_url_segment_1, encrypted_tokens, managed_key_fingerprint, dcr_registration FROM connections WHERE managed_key_fingerprint != ? AND managed_key_fingerprint != ''"
    )
    .bind(activeFingerprint)
    .all<ManagedConnection>();

  // Count already-current connections
  const currentResult = await db
    .prepare(
      "SELECT COUNT(*) as count FROM connections WHERE managed_key_fingerprint = ?"
    )
    .bind(activeFingerprint)
    .first<{ count: number }>();
  let alreadyCurrent = currentResult?.count ?? 0;

  // Update progress: starting migration
  await db
    .prepare(
      "UPDATE pending_key_rotations SET result = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(
      JSON.stringify({
        phase: 'migrating',
        message: `Re-encrypting ${connections.results.length} connections (${alreadyCurrent} already current)...`,
        total: connections.results.length,
        migrated: 0,
        errors: 0,
      }),
      row.id
    )
    .run();

  let migrated = 0;
  const errors: Array<{ connectionId: string; error: string }> = [];
  const connectionCounts: Record<string, number> = {
    total: connections.results.length,
    migrated: 0,
    errors: 0,
  };

  for (const conn of connections.results) {
    try {
      if (!conn.encrypted_tokens) {
        errors.push({ connectionId: conn.id, error: 'No encrypted tokens' });
        connectionCounts.errors++;
        continue;
      }

      // Decrypt with old key
      let oldMasterKey: string;
      try {
        oldMasterKey = getManagedKey(configKeys, conn.managed_key_fingerprint);
      } catch {
        errors.push({
          connectionId: conn.id,
          error: `No key found for fingerprint ${conn.managed_key_fingerprint}`,
        });
        connectionCounts.errors++;
        continue;
      }

      const oldCryptoKey = await deriveManagedEncryptionKey(oldMasterKey, conn.id);
      const decryptedTokens = await decryptTokenDataWithKey(conn.encrypted_tokens, oldCryptoKey);

      // Re-encrypt with active key
      const newCryptoKey = await deriveManagedEncryptionKey(activeKey.key, conn.id);
      const newEncryptedTokens = await encryptTokenDataWithKey(decryptedTokens, newCryptoKey);

      // Re-encrypt DCR registration if present (managed connections use same key for both)
      let newDcrRegistration: string | null = null;
      if (conn.dcr_registration) {
        const decryptedDcr = await decryptTokenDataWithKey(conn.dcr_registration, oldCryptoKey);
        newDcrRegistration = await encryptTokenDataWithKey(decryptedDcr, newCryptoKey);
      }

      // Update D1
      if (newDcrRegistration !== null) {
        await db
          .prepare(
            'UPDATE connections SET encrypted_tokens = ?, managed_key_fingerprint = ?, dcr_registration = ?, dcr_key_fingerprint = ? WHERE id = ?'
          )
          .bind(newEncryptedTokens, activeFingerprint, newDcrRegistration, activeFingerprint, conn.id)
          .run();
      } else {
        await db
          .prepare(
            'UPDATE connections SET encrypted_tokens = ?, managed_key_fingerprint = ? WHERE id = ?'
          )
          .bind(newEncryptedTokens, activeFingerprint, conn.id)
          .run();
      }

      // Update KV (handle missing entry gracefully)
      const kvKey = `proxy:${conn.secret_url_segment_1}`;
      const kvRaw = await kv.get(kvKey);
      if (kvRaw) {
        try {
          const kvEntry = JSON.parse(kvRaw);
          kvEntry.encryptedTokens = newEncryptedTokens;
          kvEntry.managedKeyFingerprint = activeFingerprint;
          if (newDcrRegistration !== null) {
            kvEntry.dcrRegistration = newDcrRegistration;
            kvEntry.dcrKeyFingerprint = activeFingerprint;
          }
          await kv.put(kvKey, JSON.stringify(kvEntry));
        } catch {
          errors.push({ connectionId: conn.id, error: 'Failed to update KV entry' });
          // Don't increment connectionCounts.errors — D1 was already updated successfully
        }
      }
      // Missing KV entry is fine — consistency check will rebuild it

      migrated++;
      connectionCounts.migrated++;
    } catch (err) {
      errors.push({
        connectionId: conn.id,
        error: err instanceof Error ? err.message : String(err),
      });
      connectionCounts.errors++;
    }
  }

  // Phase 2: Re-encrypt DCR registrations for zero_knowledge connections.
  // ZK connections store dcr_registration encrypted with managed keys but their
  // encrypted_tokens use the user's secret2, so only dcr_registration is rotated here.
  // Managed connections with DCR were already handled in Phase 1 above.
  const zkDcrConnections = await db
    .prepare(
      "SELECT id, secret_url_segment_1, dcr_registration, dcr_key_fingerprint FROM connections WHERE dcr_registration IS NOT NULL AND dcr_key_fingerprint != ? AND dcr_key_fingerprint != '' AND key_storage_mode = 'zero_knowledge'"
    )
    .bind(activeFingerprint)
    .all<{ id: string; secret_url_segment_1: string; dcr_registration: string; dcr_key_fingerprint: string }>();

  for (const conn of zkDcrConnections.results) {
    try {
      let oldMasterKey: string;
      try {
        oldMasterKey = getManagedKey(configKeys, conn.dcr_key_fingerprint);
      } catch {
        errors.push({
          connectionId: conn.id,
          error: `ZK DCR: No key found for fingerprint ${conn.dcr_key_fingerprint}`,
        });
        connectionCounts.errors++;
        continue;
      }

      const oldCryptoKey = await deriveManagedEncryptionKey(oldMasterKey, conn.id);
      const newCryptoKey = await deriveManagedEncryptionKey(activeKey.key, conn.id);

      const decryptedDcr = await decryptTokenDataWithKey(conn.dcr_registration, oldCryptoKey);
      const newDcrRegistration = await encryptTokenDataWithKey(decryptedDcr, newCryptoKey);

      await db
        .prepare(
          'UPDATE connections SET dcr_registration = ?, dcr_key_fingerprint = ? WHERE id = ?'
        )
        .bind(newDcrRegistration, activeFingerprint, conn.id)
        .run();

      // Update KV cache
      const kvKey = `proxy:${conn.secret_url_segment_1}`;
      const kvRaw = await kv.get(kvKey);
      if (kvRaw) {
        try {
          const kvEntry = JSON.parse(kvRaw);
          kvEntry.dcrRegistration = newDcrRegistration;
          kvEntry.dcrKeyFingerprint = activeFingerprint;
          await kv.put(kvKey, JSON.stringify(kvEntry));
        } catch {
          // KV update failure is non-fatal — consistency check will fix it
        }
      }

      migrated++;
      connectionCounts.migrated++;
    } catch (err) {
      errors.push({
        connectionId: conn.id,
        error: `ZK DCR: ${err instanceof Error ? err.message : String(err)}`,
      });
      connectionCounts.errors++;
    }
  }

  // Scrub new_key_hex and mark completed
  await db
    .prepare(
      "UPDATE pending_key_rotations SET status = 'completed', new_key_hex = '', result = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(
      JSON.stringify({
        phase: 'migrated',
        migrated,
        alreadyCurrent,
        errors,
        connectionCounts,
      }),
      row.id
    )
    .run();
}

export async function detectOrphanedFingerprints(
  db: D1Database,
  configFingerprints: string[],
  logger: { error: (...args: unknown[]) => void }
): Promise<void> {
  // Query all distinct fingerprints referenced by connections
  const result = await db
    .prepare(
      "SELECT DISTINCT fp FROM (SELECT managed_key_fingerprint AS fp FROM connections WHERE managed_key_fingerprint != '' UNION SELECT dcr_key_fingerprint AS fp FROM connections WHERE dcr_key_fingerprint != '')"
    )
    .all<{ fp: string }>();

  const configSet = new Set(configFingerprints);

  for (const row of result.results) {
    if (!configSet.has(row.fp)) {
      logger.error(
        `Connections reference key fingerprint "${row.fp}" which is not present in MANAGED_ENCRYPTION_KEYS. These connections' managed-key-encrypted data cannot be decrypted.`
      );
    }
  }
}
