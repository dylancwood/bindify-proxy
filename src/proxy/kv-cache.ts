import type { Connection, User, TokenData, ApiKeyData } from '@bindify/types';
import type { Env } from '../index';
import type { AccessActiveResult } from '../auth/entitlements';
import { decryptTokenData, deriveManagedEncryptionKey, decryptTokenDataWithKey, getManagedKey } from '../crypto';
import type { ManagedKeyEntry } from '../crypto';
import { validateDecryptedTokens } from '../token-parsing';
import { log } from '../logger';
import { writeConnectionEvent } from '../db/connection-events';

export const PROXY_CACHE_SCHEMA_VERSION = 2;

const PROXY_CACHE_KEY_PREFIX = 'proxy:';

export interface ProxyCacheEntry {
  schemaVersion: number;
  connectionId: string;
  userId: string;
  service: string;
  status: string;
  authType: 'oauth' | 'api_key';
  authMode: string | null;
  application: string | null;
  keyStorageMode: 'managed' | 'zero_knowledge';
  keyVersion: number;
  dcrRegistration: string | null;
  needsReauthAt: string | null;
  encryptedTokens: string;
  user: {
    plan: string;
    trialEndsAt: string | null;
    accessUntil: string | null;
  };
  subscriptionStatus: string | null;
  subscriptionPastDueSince: string | null;
  cachedAt: string;
}

export async function withProxyCache<T>(
  env: Env,
  secret1: string,
  ctx: ExecutionContext | null,
  mutator: (entry: ProxyCacheEntry, write: (opts?: { isTokenUpdate?: boolean }) => Promise<void>) => Promise<T>
): Promise<T | null> {
  const key = `${PROXY_CACHE_KEY_PREFIX}${secret1}`;
  const raw = await env.KV.get(key);
  if (!raw) return null;

  let entry: ProxyCacheEntry;
  try {
    entry = JSON.parse(raw);
  } catch {
    await env.KV.delete(key);
    return null;
  }

  // Schema version check
  if (entry.schemaVersion !== PROXY_CACHE_SCHEMA_VERSION) {
    await env.KV.delete(key);
    return null;
  }

  const write = async (opts?: { isTokenUpdate?: boolean }) => {
    await env.KV.put(key, JSON.stringify(entry));

    const d1BackupFn = async () => {
      const stmt = env.DB
        .prepare('UPDATE connections SET encrypted_tokens = ?, key_version = ? WHERE id = ?')
        .bind(entry.encryptedTokens, entry.keyVersion, entry.connectionId);

      if (!opts?.isTokenUpdate) {
        // Metadata-only write: single attempt, silent catch (existing behavior)
        await stmt.run().catch(() => {});
        return;
      }

      // Token write: retry once, then write recovery event
      try {
        await stmt.run();
      } catch (firstErr) {
        log.warn('D1 backup write failed, retrying', {
          connectionId: entry.connectionId,
          error: firstErr instanceof Error ? firstErr.message : String(firstErr),
        });
        try {
          await env.DB
            .prepare('UPDATE connections SET encrypted_tokens = ?, key_version = ? WHERE id = ?')
            .bind(entry.encryptedTokens, entry.keyVersion, entry.connectionId)
            .run();
        } catch (retryErr) {
          log.warn('D1 backup write retry failed, writing recovery event', {
            connectionId: entry.connectionId,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          try {
            await writeConnectionEvent(env.DB, {
              connectionId: entry.connectionId,
              eventType: 'token_refresh',
              category: 'd1_write_failed',
              detail: 'D1 backup write failed after retry',
              encryptedPayload: entry.encryptedTokens,
            });
          } catch (eventErr) {
            log.error('Failed to write D1 recovery event', eventErr instanceof Error ? eventErr : undefined, {
              connectionId: entry.connectionId,
            });
          }
        }
      }
    };

    if (ctx) {
      ctx.waitUntil(d1BackupFn());
    } else {
      await d1BackupFn();
    }
  };

  return mutator(entry, write);
}

export async function writeProxyCache(env: Env, secret1: string, entry: ProxyCacheEntry): Promise<void> {
  const key = `${PROXY_CACHE_KEY_PREFIX}${secret1}`;
  await env.KV.put(key, JSON.stringify(entry));
}

export async function deleteProxyCache(env: Env, secret1: string): Promise<void> {
  const key = `${PROXY_CACHE_KEY_PREFIX}${secret1}`;
  // Write a tombstone instead of deleting. KV deletes are eventually consistent and can take
  // up to 60s to propagate across edge locations. Tombstone writes propagate faster.
  // The schema version mismatch (0 !== PROXY_CACHE_SCHEMA_VERSION) causes withProxyCache
  // to return null immediately, which the proxy handler treats as 404.
  await env.KV.put(key, JSON.stringify({ schemaVersion: 0, deleted: true }), { expirationTtl: 300 });
}

export function checkCachedAccessActive(
  user: ProxyCacheEntry['user'],
  subscriptionStatus: string | null,
  subscriptionPastDueSince: string | null
): AccessActiveResult {
  // Free trial
  if (user.plan === 'free_trial') {
    if (!user.trialEndsAt) {
      return { active: false, reason: 'No trial period set' };
    }
    if (new Date(user.trialEndsAt) > new Date()) {
      return { active: true };
    }
    return { active: false, reason: 'Free trial has expired' };
  }

  // Canceled: check access_until
  if (user.plan === 'canceled') {
    if (user.accessUntil && new Date(user.accessUntil) > new Date()) {
      return { active: true };
    }
    return { active: false, reason: 'Subscription canceled and access period ended' };
  }

  // Check subscription status
  if (subscriptionStatus === 'active' || subscriptionStatus === 'trialing') {
    return { active: true };
  }

  // past_due grace period (3 days)
  if (subscriptionStatus === 'past_due' && subscriptionPastDueSince) {
    const elapsed = Date.now() - new Date(subscriptionPastDueSince).getTime();
    const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
    if (elapsed < GRACE_PERIOD_MS) {
      return { active: true };
    }
    return { active: false, reason: 'Payment past due for more than 3 days' };
  }

  return { active: false, reason: 'No active subscription' };
}

export async function decryptCacheTokens(
  entry: Pick<ProxyCacheEntry, 'authType' | 'keyStorageMode' | 'keyVersion' | 'connectionId' | 'encryptedTokens'>,
  secret2: string,
  managedEncryptionKeys: ManagedKeyEntry[]
): Promise<TokenData | ApiKeyData> {
  let decrypted: string;

  if (entry.keyStorageMode === 'managed') {
    const masterKey = getManagedKey(managedEncryptionKeys, entry.keyVersion);
    const key = await deriveManagedEncryptionKey(masterKey, entry.connectionId);
    decrypted = await decryptTokenDataWithKey(entry.encryptedTokens, key);
  } else {
    decrypted = await decryptTokenData(entry.encryptedTokens, secret2);
  }

  const parsed = JSON.parse(decrypted);
  validateDecryptedTokens(parsed, entry.authType);
  return parsed;
}

export function buildProxyCacheEntry(
  connection: Connection,
  user: User,
  subscriptionStatus: string | null,
  subscriptionPastDueSince: string | null,
  encryptedTokens: string
): ProxyCacheEntry {
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    connectionId: connection.id,
    userId: connection.user_id,
    service: connection.service,
    status: connection.status,
    authType: connection.auth_type,
    authMode: connection.auth_mode,
    application: connection.application,
    keyStorageMode: connection.key_storage_mode,
    keyVersion: connection.key_version,
    dcrRegistration: connection.dcr_registration,
    needsReauthAt: connection.needs_reauth_at,
    encryptedTokens,
    user: {
      plan: user.plan,
      trialEndsAt: user.trial_ends_at,
      accessUntil: user.access_until,
    },
    subscriptionStatus,
    subscriptionPastDueSince,
    cachedAt: new Date().toISOString(),
  };
}
