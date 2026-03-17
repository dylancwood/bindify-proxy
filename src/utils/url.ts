import type { Env } from '../index';

export function getCallbackUrl(env: Env): string {
  const adminOrigin = env.ADMIN_URL.split(',')[0].trim();
  const workerOrigin = adminOrigin.replace('app.stg.', 'api.stg.').replace('app.', 'api.');
  return `${workerOrigin}/api/connections/callback`;
}
