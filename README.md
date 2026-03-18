# Bindify API Worker

This is the production source code for the [Bindify](https://bindify.dev) API — an MCP authentication proxy that connects AI assistants to third-party services like Linear, Todoist, GitHub, Atlassian, Notion, and Figma.

## Why This Repo Is Public

Bindify handles MCP requests on behalf of users. Our security page states that we don't log or store request payloads. Rather than asking you to trust that claim, we publish the code so you can verify it yourself.

This is the exact code deployed to production at `api.bindify.dev`.

## Architecture

The worker runs on Cloudflare Workers and handles:

- **MCP Proxy** — Forwards MCP requests to upstream services via secret URLs or API keys. Request payloads pass through but are never logged or stored. See [`src/proxy/handler.ts`](src/proxy/handler.ts).
- **Token Encryption** — OAuth tokens are encrypted at rest using AES-256-GCM. In zero-knowledge mode, the decryption key is part of the user's secret URL and never stored on our servers. See [`src/crypto.ts`](src/crypto.ts).
- **Secret Scrubbing** — All structured logs are scrubbed to prevent accidental secret exposure. API keys, bearer tokens, and encrypted payloads are automatically redacted. See [`src/logger.ts`](src/logger.ts).
- **OAuth Flows** — Handles authorization and callback flows for each supported service. See [`src/services/`](src/services/).
- **Billing** — Stripe integration for subscriptions. See [`src/billing/`](src/billing/).
- **Auth** — Clerk JWT verification with lazy user provisioning. See [`src/auth/`](src/auth/).

### Request Flow

1. Client sends MCP request to `https://api.bindify.dev/mcp/{service}/{credentials}`
2. Worker validates the credentials (API key or secret URL segments)
3. Worker decrypts the stored OAuth token (or uses the API key directly)
4. Worker forwards the request to the upstream MCP server
5. Worker streams the response back to the client
6. No request or response payloads are logged at any point

### Data Storage

- **D1** (SQLite) — User accounts, connections (metadata only), subscriptions, events
- **KV** — Encrypted token blobs, rate limit counters, blocklist cache
- **No request payload storage** — Proxied data is forwarded and discarded

## Key Security Properties

| Property | Implementation | Code |
|----------|---------------|------|
| No payload logging | Proxy forwards without logging body | [`src/proxy/handler.ts`](src/proxy/handler.ts) |
| Secret scrubbing | Logger redacts API keys, tokens, credentials | [`src/logger.ts`](src/logger.ts) |
| Zero-knowledge encryption | Secret2 never stored; used as AES-256-GCM key | [`src/crypto.ts`](src/crypto.ts) |
| Managed encryption | Versioned master keys with HKDF key derivation | [`src/crypto.ts`](src/crypto.ts) |
| Token refresh | Automatic cron-based refresh with locking | [`src/scheduler.ts`](src/scheduler.ts) |

## Local Development

### Prerequisites

- Node.js 20+
- A Cloudflare account (free tier works)
- OAuth app credentials for the services you want to test

### Setup

```bash
# Install dependencies
npm install

# Copy the example env file and fill in your values
cp .dev.vars.example .dev.vars

# Create a local D1 database and run migrations
npx wrangler d1 migrations apply your-db-name --local

# Copy and configure wrangler.toml from the example
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your Cloudflare account ID and resource IDs

# Start the dev server
npm run dev
```

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

Tests use Miniflare (local Cloudflare Workers simulation) with mock bindings — no real credentials needed.

## Environment Variables

See [`.dev.vars.example`](.dev.vars.example) for the full list with descriptions. Key groups:

| Group | Variables | Required |
|-------|-----------|----------|
| Auth (Clerk) | `CLERK_PUBLISHABLE_KEY`, `CLERK_JWKS_URL`, `CLERK_SECRET_KEY` | Yes |
| Billing (Stripe) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CONNECTIONS` | Yes |
| Encryption | `MANAGED_ENCRYPTION_KEYS` or `MANAGED_ENCRYPTION_MASTER_KEY` | Yes |
| CORS | `ADMIN_URL` | Yes |
| OAuth Providers | `{SERVICE}_CLIENT_ID`, `{SERVICE}_CLIENT_SECRET` | Per service |
| Email | `SMTP2GO_API_KEY`, `ADMIN_NOTIFICATION_EMAIL` | No |
| Zoho Desk | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, etc. | No |

## Deployment

This repo does **not** deploy directly. It is referenced as a git submodule in the private [bindify monorepo](https://github.com/dylancwood/bindify), which orchestrates all deployments to ensure correct ordering (migrations before code, coordinated with admin UI and other services).

CI in this repo runs tests only. To deploy changes:

1. Push to `main` here (tests run)
2. In the monorepo, bump the submodule and push — this triggers the full deployment pipeline

## License

Apache 2.0 — see [LICENSE](LICENSE).
