import type { TokenData } from '../../../shared/types';

export interface PreWriteValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates new token data before encryption and write.
 * Runs after parseTokenResponse override (if any), before encryptTokenData.
 * Guards against buggy overrides and upstream responses that slipped through Layer 1.
 */
export function validateTokensBeforeWrite(
  oldTokens: TokenData,
  newTokens: TokenData
): PreWriteValidationResult {
  if (!newTokens.access_token || typeof newTokens.access_token !== 'string') {
    return { valid: false, error: 'New tokens have empty or missing access_token' };
  }

  if (oldTokens.refresh_token && !newTokens.refresh_token) {
    return { valid: false, error: 'New tokens lost refresh_token that existed in old tokens' };
  }

  if (!Number.isFinite(newTokens.expires_at) || newTokens.expires_at <= 0) {
    return { valid: false, error: 'New tokens have invalid expires_at (must be positive number)' };
  }

  return { valid: true };
}
