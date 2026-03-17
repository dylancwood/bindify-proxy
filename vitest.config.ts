import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { readFileSync } from 'node:fs';

// Load .env.test into process.env for integration tests (e.g. LINEAR_TEST_API_KEY)
try {
  const envTest = readFileSync('.env.test', 'utf-8');
  for (const line of envTest.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
  }
} catch {}

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ADMIN_URL: process.env.ADMIN_URL || 'http://localhost:5173',
            CLERK_JWKS_URL: process.env.CLERK_JWKS_URL || 'https://settled-mosquito-25.clerk.accounts.dev/.well-known/jwks.json',
            CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY || 'pk_test_placeholder',
            STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder',
            STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder',
            STRIPE_PRICE_CONNECTIONS: process.env.STRIPE_PRICE_CONNECTIONS || 'price_test_connections',
            IP_ALLOWLIST: '10.0.0.1,10.0.0.2',
            MANAGED_ENCRYPTION_KEYS: JSON.stringify([
              { version: 1, key: 'test-master-key-0123456789abcdef0123456789abcdef' },
            ]),
            MANAGED_ENCRYPTION_MASTER_KEY: 'test-master-key-0123456789abcdef0123456789abcdef',
            CONFIG: JSON.stringify({ proxyCacheTtlSeconds: 3600, refreshLockTtlSeconds: 3 }),
            ...(process.env.LINEAR_TEST_API_KEY ? { LINEAR_TEST_API_KEY: process.env.LINEAR_TEST_API_KEY } : {}),
          },
        },
      },
    },
  },
});
