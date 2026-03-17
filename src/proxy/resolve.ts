import { log } from '../logger';

export function parseApiKey(apiKey: string): { credentials: string } | null {
  // Format: bnd_{env}_{credentials} where credentials is 86 chars of base64url
  const match = apiKey.match(/^bnd_(?:live|stg|test)_([A-Za-z0-9_-]{86})$/);
  if (!match) {
    log.warn('Invalid API key format attempt', { prefix: apiKey.slice(0, 10) });
    return null;
  }
  return { credentials: match[1] };
}
