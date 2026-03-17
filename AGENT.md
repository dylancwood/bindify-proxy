# Bindify API Worker (bindify-proxy)

This is the open-source API worker deployed at `api.bindify.dev`.

The **admin UI, marketing site, and shared types** live in a separate private monorepo: `~/Documents/github/bindify`.

## Cross-repo changes

If a change affects both the API and UI (e.g. adding a field to a type, changing an endpoint):

1. **Shared types** — `types/index.ts` in this repo and `shared/types.ts` in the monorepo must stay in sync manually.
2. **Admin app** — The UI that calls these API endpoints is at `packages/admin/` in the monorepo.
3. **Environment config** — Worker env vars are documented in `.dev.vars.example` and `wrangler.toml.example` in this repo.
