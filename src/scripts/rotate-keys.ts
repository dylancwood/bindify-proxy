/**
 * Key rotation script for Bindify managed encryption keys.
 *
 * Communicates with the worker via D1 `pending_key_rotations` table.
 * The worker's cron processes the rows (validation, migration).
 *
 * Usage:
 *   npx tsx src/scripts/rotate-keys.ts --keys-file ./keys.json --env staging
 *   npx tsx src/scripts/rotate-keys.ts --keys-file ./keys.json --env production
 *   npx tsx src/scripts/rotate-keys.ts --keys-file ./keys.json --env production --remove <fingerprint>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

import {
  computeLocalFingerprint,
  compareKeySets,
  checkGitSafety,
  validateRemoval,
} from './rotate-keys-core';
import type { KeyEntry } from './rotate-keys-core';

// Re-export core functions for convenience
export {
  computeLocalFingerprint,
  compareKeySets,
  checkGitSafety,
  validateRemoval,
} from './rotate-keys-core';
export type { KeyEntry, CompareResult } from './rotate-keys-core';

// ─── Wrangler helpers ───

function getD1DatabaseName(env: string): string {
  // Convention: staging uses 'bindify-db-staging', production uses 'bindify-db'
  return env === 'staging' ? 'bindify-db-staging' : 'bindify-db';
}

function wranglerEnvFlag(env: string): string {
  return env === 'staging' ? '--env staging' : '';
}

function execWranglerD1(sql: string, dbName: string, env: string): string {
  const envFlag = wranglerEnvFlag(env);
  const cmd = `wrangler d1 execute ${dbName} ${envFlag} --command="${sql.replace(/"/g, '\\"')}" --json`;
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err: any) {
    throw new Error(`wrangler d1 execute failed: ${err.stderr || err.message}`);
  }
}

function execWranglerD1WithStdin(sql: string, dbName: string, env: string): string {
  const envFlag = wranglerEnvFlag(env);
  const cmd = `wrangler d1 execute ${dbName} ${envFlag} --json`;
  try {
    return execSync(cmd, { encoding: 'utf-8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err: any) {
    throw new Error(`wrangler d1 execute failed: ${err.stderr || err.message}`);
  }
}

function parseD1Result(output: string): any[] {
  try {
    const parsed = JSON.parse(output);
    // wrangler d1 --json returns an array of result objects
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0].results || [];
    }
    return [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main script ───

interface CliArgs {
  keysFile: string;
  env: string;
  remove?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let keysFile = '';
  let env = '';
  let remove: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keys-file' && args[i + 1]) {
      keysFile = args[++i];
    } else if (args[i] === '--env' && args[i + 1]) {
      env = args[++i];
    } else if (args[i] === '--remove' && args[i + 1]) {
      remove = args[++i];
    }
  }

  if (!keysFile) {
    console.error('Usage: rotate-keys --keys-file <path> --env <staging|production> [--remove <fingerprint>]');
    process.exit(1);
  }
  if (!env || !['staging', 'production'].includes(env)) {
    console.error('--env must be "staging" or "production"');
    process.exit(1);
  }

  return { keysFile, env, remove };
}

async function handleRemove(args: CliArgs): Promise<void> {
  const { keysFile, env, remove: fingerprint } = args;
  if (!fingerprint) return;

  const dbName = getD1DatabaseName(env);
  const keys: KeyEntry[] = JSON.parse(readFileSync(keysFile, 'utf-8'));
  const localFingerprints = keys.map((k) => computeLocalFingerprint(k.key));

  // Query connection count for this fingerprint
  const countOutput = execWranglerD1(
    `SELECT COUNT(*) as cnt FROM connections WHERE key_storage_mode = 'managed' AND key_fingerprint = '${fingerprint}'`,
    dbName,
    env
  );
  const countRows = parseD1Result(countOutput);
  const connectionCount = countRows.length > 0 ? (countRows[0].cnt || 0) : 0;

  const validation = validateRemoval(fingerprint, localFingerprints, connectionCount);
  if (!validation.ok) {
    console.error(`Cannot remove key: ${validation.error}`);
    process.exit(1);
  }

  // Remove from keys.json
  const updatedKeys = keys.filter((k) => computeLocalFingerprint(k.key) !== fingerprint);
  writeFileSync(keysFile, JSON.stringify(updatedKeys, null, 2) + '\n');
  console.log(`Removed fingerprint ${fingerprint} from ${keysFile}`);

  // Update wrangler secret
  const secretJson = JSON.stringify(updatedKeys);
  const envFlag = wranglerEnvFlag(env);
  try {
    execSync(`echo '${secretJson}' | wrangler secret put MANAGED_ENCRYPTION_KEYS ${envFlag}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('Updated MANAGED_ENCRYPTION_KEYS secret');
  } catch (err: any) {
    console.error(`Failed to update secret: ${err.stderr || err.message}`);
    process.exit(1);
  }

  console.log('Key removal complete.');
}

async function handleRotation(args: CliArgs): Promise<void> {
  const { keysFile, env } = args;
  const dbName = getD1DatabaseName(env);

  // Step 1: Read keys.json
  const keys: KeyEntry[] = JSON.parse(readFileSync(keysFile, 'utf-8'));
  const localFingerprints = keys.map((k) => computeLocalFingerprint(k.key));

  console.log(`Local keys (${keys.length}):`);
  for (const fp of localFingerprints) {
    console.log(`  ${fp}`);
  }

  // Step 2: Check for existing pending/migrate rows
  const pendingOutput = execWranglerD1(
    "SELECT id, status FROM pending_key_rotations WHERE status IN ('pending', 'migrate', 'validated')",
    dbName,
    env
  );
  const pendingRows = parseD1Result(pendingOutput);
  if (pendingRows.length > 0) {
    console.error(
      `There are existing in-progress rotation rows:\n${JSON.stringify(pendingRows, null, 2)}\nWait for them to complete or clean up manually.`
    );
    process.exit(1);
  }

  // Step 3: Get remote fingerprints
  const remoteFpOutput = execWranglerD1(
    "SELECT DISTINCT key_fingerprint FROM connections WHERE key_storage_mode = 'managed' AND key_fingerprint != ''",
    dbName,
    env
  );
  const remoteFingerprints = parseD1Result(remoteFpOutput).map((r: any) => r.key_fingerprint as string);

  console.log(`Remote fingerprints (${remoteFingerprints.length}):`);
  for (const fp of remoteFingerprints) {
    console.log(`  ${fp}`);
  }

  // Step 4: Compare key sets
  const comparison = compareKeySets(localFingerprints, remoteFingerprints, keys);

  if (comparison.action === 'abort') {
    console.error(`Aborting: ${comparison.error}`);
    process.exit(1);
  }

  const newKeyHex = comparison.newKeyHex!;
  const newKeyFingerprint = computeLocalFingerprint(newKeyHex);

  if (comparison.action === 'generate') {
    console.log(`Generated new key with fingerprint: ${newKeyFingerprint}`);
  } else {
    console.log(`Using existing extra key with fingerprint: ${newKeyFingerprint}`);
  }

  // Step 5: Write updated keys.json BEFORE remote operations
  const updatedKeys = comparison.updatedKeys!;
  writeFileSync(keysFile, JSON.stringify(updatedKeys, null, 2) + '\n');
  console.log(`Updated ${keysFile} (${updatedKeys.length} keys)`);

  // Compute expected fingerprints (all keys that should be in the config after rotation)
  const expectedFingerprints = updatedKeys.map((k) => computeLocalFingerprint(k.key));

  // Step 6: Insert pending rotation row (use stdin to avoid shell history exposure)
  const insertSql =
    `INSERT INTO pending_key_rotations (expected_fingerprints, new_key_hex, new_key_fingerprint) ` +
    `VALUES ('${JSON.stringify(expectedFingerprints)}', '${newKeyHex}', '${newKeyFingerprint}')`;
  execWranglerD1WithStdin(insertSql, dbName, env);
  console.log('Inserted pending rotation row. Waiting for cron validation...');

  // Step 7: Poll for validation
  const maxValidationWait = 15 * 60 * 1000; // 15 minutes
  const pollInterval = 15_000; // 15 seconds
  const startTime = Date.now();

  let status = 'pending';
  let result: any = null;

  while (Date.now() - startTime < maxValidationWait) {
    await sleep(pollInterval);

    const statusOutput = execWranglerD1(
      `SELECT status, result FROM pending_key_rotations WHERE new_key_fingerprint = '${newKeyFingerprint}' ORDER BY id DESC LIMIT 1`,
      dbName,
      env
    );
    const rows = parseD1Result(statusOutput);
    if (rows.length === 0) {
      console.error('Rotation row disappeared from D1!');
      process.exit(1);
    }

    status = rows[0].status;
    result = rows[0].result ? JSON.parse(rows[0].result) : null;

    if (status !== 'pending') break;
    process.stdout.write('.');
  }

  console.log('');

  if (status === 'pending') {
    console.error('Timed out waiting for cron validation. The row is still pending.');
    console.error('Check that the cron is running and try again later.');
    process.exit(1);
  }

  if (status === 'failed' || status === 'rejected') {
    console.error(`Rotation ${status}: ${JSON.stringify(result, null, 2)}`);
    process.exit(1);
  }

  if (status !== 'validated') {
    console.error(`Unexpected status: ${status}`);
    process.exit(1);
  }

  console.log('Validation passed. Deploying new secret...');

  // Step 8: wrangler secret put MANAGED_ENCRYPTION_KEYS
  const secretJson = JSON.stringify(updatedKeys);
  const envFlag = wranglerEnvFlag(env);
  try {
    execSync(`echo '${secretJson}' | wrangler secret put MANAGED_ENCRYPTION_KEYS ${envFlag}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('Secret updated. Waiting for deploy propagation...');
  } catch (err: any) {
    console.error(`Failed to update secret: ${err.stderr || err.message}`);
    console.error('The rotation row is still validated. Re-run wrangler secret put manually, then set status to migrate.');
    process.exit(1);
  }

  // Step 9: Wait for deploy propagation
  await sleep(10_000); // 10s initial wait for deploy

  // Step 10: Set row status to 'migrate'
  execWranglerD1(
    `UPDATE pending_key_rotations SET status = 'migrate', updated_at = datetime('now') WHERE new_key_fingerprint = '${newKeyFingerprint}' AND status = 'validated'`,
    dbName,
    env
  );
  console.log("Set rotation status to 'migrate'. Waiting for cron to complete migration...");

  // Step 11: Poll until completed
  const maxMigrationWait = 30 * 60 * 1000; // 30 minutes
  const migrationStart = Date.now();
  status = 'migrate';

  while (Date.now() - migrationStart < maxMigrationWait) {
    await sleep(pollInterval);

    const statusOutput = execWranglerD1(
      `SELECT status, result FROM pending_key_rotations WHERE new_key_fingerprint = '${newKeyFingerprint}' ORDER BY id DESC LIMIT 1`,
      dbName,
      env
    );
    const rows = parseD1Result(statusOutput);
    if (rows.length === 0) {
      console.error('Rotation row disappeared from D1!');
      process.exit(1);
    }

    status = rows[0].status;
    result = rows[0].result ? JSON.parse(rows[0].result) : null;

    if (status !== 'migrate') break;
    process.stdout.write('.');
  }

  console.log('');

  if (status === 'migrate') {
    console.error('Timed out waiting for cron migration. The row is still in migrate status.');
    console.error('Check that the cron is running. Migration will resume on next cron run.');
    process.exit(1);
  }

  if (status === 'completed') {
    console.log('\n=== Rotation Complete ===');
    console.log(`New active key fingerprint: ${newKeyFingerprint}`);
    if (result) {
      console.log(`Connections migrated: ${result.migrated || 0}`);
      console.log(`Errors: ${result.errors?.length || 0}`);
      if (result.errors?.length > 0) {
        console.log('Error details:');
        for (const e of result.errors) {
          console.log(`  ${e.connectionId}: ${e.error}`);
        }
      }
    }
  } else {
    console.error(`Migration ended with unexpected status: ${status}`);
    console.error(`Result: ${JSON.stringify(result, null, 2)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Safety check: keys file should not be in a git repo
  checkGitSafety(args.keysFile);

  if (!existsSync(args.keysFile)) {
    console.error(`Keys file not found: ${args.keysFile}`);
    process.exit(1);
  }

  if (args.remove) {
    await handleRemove(args);
  } else {
    await handleRotation(args);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
