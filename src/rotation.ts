import type { D1Database } from '@cloudflare/workers-types';

export async function detectOrphanedFingerprints(
  db: D1Database,
  configFingerprints: string[],
  logger: { error: (...args: unknown[]) => void }
): Promise<void> {
  const result = await db
    .prepare(
      "SELECT DISTINCT key_fingerprint FROM connections WHERE key_storage_mode = 'managed'"
    )
    .all<{ key_fingerprint: string }>();

  const configSet = new Set(configFingerprints);

  for (const row of result.results) {
    if (row.key_fingerprint === '') continue;
    if (!configSet.has(row.key_fingerprint)) {
      logger.error(
        `Managed connections reference key fingerprint "${row.key_fingerprint}" which is not present in MANAGED_ENCRYPTION_KEYS. These connections cannot be decrypted.`
      );
    }
  }
}
