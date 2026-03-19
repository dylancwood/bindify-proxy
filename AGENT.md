# Bindify API Worker (bindify-proxy)

This is the open-source API worker deployed at `api.bindify.dev`.

The **admin UI, marketing site, and shared types** live in a separate private monorepo: `~/Documents/github/bindify`.

## Deployment

**This repo does NOT deploy directly.** CI only runs tests. All deployments go through the monorepo.

This repo is referenced as a **git submodule** at `packages/worker-submodule` in the monorepo. To deploy changes:

1. Push your changes to `main` in this repo (tests run automatically)
2. In the monorepo (`~/Documents/github/bindify`):
   ```bash
   cd packages/worker-submodule && git pull origin main && cd ../..
   git add packages/worker-submodule
   git commit -m "chore: bump worker to $(git -C packages/worker-submodule rev-parse --short HEAD)"
   git push
   ```
3. This triggers the monorepo's staging deploy (runs migrations, deploys worker, deploys all other packages in correct order)
4. Verify staging at `api.stg.bindify.dev`
5. Production deploys automatically after staging smoke tests pass, or manually via GitHub Actions workflow dispatch on the monorepo

**Why this process?** The worker shares a D1 database with other monorepo packages. The monorepo's CI guarantees correct deployment ordering (migrations before code) and keeps everything in sync.

## Cross-repo changes

If a change affects both the API and UI (e.g. adding a field to a type, changing an endpoint):

1. **Shared types** — `types/index.ts` in this repo and `shared/types.ts` in the monorepo must stay in sync manually. TypeScript won't catch drift between them — review type changes when bumping the submodule.
2. **Admin app** — The UI that calls these API endpoints is at `packages/admin/` in the monorepo.
3. **Coordinated changes** — Push worker changes here first, then bump the submodule and make monorepo changes in a single commit. This ensures everything deploys together.
4. **Environment config** — Worker env vars are documented in `.dev.vars.example` and `wrangler.toml.example` in this repo.

## Secrets

The real `wrangler.toml` is gitignored. CI injects it from the `WRANGLER_TOML` GitHub secret. When `wrangler.toml` changes, **both repos' secrets must be updated**.

**IMPORTANT: Run these commands from the standalone repo (`~/Documents/github/bindify-proxy`), NOT from a submodule checkout.** The submodule does not contain the full `wrangler.toml`.

```bash
# From ~/Documents/github/bindify-proxy (NOT a submodule checkout)
gh secret set WRANGLER_TOML < wrangler.toml
gh secret set WORKER_WRANGLER_TOML -R dylancwood/bindify < wrangler.toml
```
