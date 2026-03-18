# Cross-Repo Linear Daemon Adaptation

## Context

The `linear-daemon.sh` script in the bindify monorepo polls Linear for issues labeled `claude` and spawns headless Claude Code instances to work on them. The API worker source code has been extracted to a separate public repo (`bindify-proxy`), referenced as a git submodule at `packages/worker` in the monorepo.

Tasks may require changes to the monorepo only, bindify-proxy only, or both. The daemon needs to support all three cases without manual intervention.

## Design

### Approach: Submodule-Aware Worktrees

The daemon continues to spawn agents in monorepo worktrees via `claude --worktree`. When a task involves the worker, the agent initializes the submodule inside the worktree, works on it as a normal git repo (branch, commit, push), then bumps the submodule ref in the monorepo.

This was validated experimentally:
- `git submodule update --init` works inside worktrees and produces a full clone with correct remotes
- The agent can create branches, commit, and push from the submodule
- Submodule ref changes are visible to the parent monorepo's `git status`

### Cleanup Issue

`git worktree remove` fails on worktrees containing initialized submodules (`fatal: working trees containing submodules cannot be moved or removed`). Claude Code cannot clean these up automatically. The daemon must handle cleanup itself.

The worktree path is available in the stream-json output's `init` event: `{"type":"system","subtype":"init","cwd":"<worktree_path>"}`.

## Changes

### 1. Prompt Changes (`build_prompt`)

Add a new section to the agent prompt:

```
## Cross-Repo Work (Worker / bindify-proxy)

The API worker source is at `packages/worker/` (a git submodule pointing to bindify-proxy).
If your task requires changes to the worker:

1. Run: `git submodule update --init packages/worker`
2. `cd packages/worker` and create a branch: `git checkout -b <identifier-slug>`
3. Make your changes and commit them on the branch
4. Run tests: `npm test` — bail out if they fail after 3 fix attempts
5. Merge to main and pull latest:
   - `git checkout main && git pull origin main`
   - `git merge <identifier-slug>`
   - If merge conflicts: bail out, comment on the Linear issue, move to Todo
6. Run tests again against the merged result — bail out if they fail
7. Push: `git push origin main`
8. Wait for CI: `gh run watch --exit-status`
   - If CI fails: bail out, comment on the Linear issue, move to Todo
9. `cd` back to the monorepo root
10. `git add packages/worker` to update the submodule ref
11. Include the submodule bump in your monorepo commit

If the task ONLY affects the worker and not the monorepo, you still need to
bump the submodule so deployment picks it up.

Read `AGENT.md` (monorepo root) for deployment and cross-repo details.
After step 1, read `packages/worker/AGENT.md` for worker-specific context.
```

### 2. New Tracking Arrays

```bash
declare -A WORKER_WORKTREE=()    # PID -> worktree directory path
declare -A WORKER_BRANCH=()      # PID -> worktree branch name
```

### 3. Worktree Path Extraction (`spawn_worker`)

After spawning the `claude -p` process, parse the first `init` event from the log file to extract the worktree path:

```bash
local worktree_path=""
local branch_name=""
for i in {1..30}; do
  if [[ -f "$log_file" ]]; then
    worktree_path=$(grep -m1 '"subtype":"init"' "$log_file" | jq -r '.cwd // empty' 2>/dev/null)
    if [[ -n "$worktree_path" ]]; then
      branch_name=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null)
      break
    fi
  fi
  sleep 1
done
if [[ -z "$worktree_path" ]]; then
  log "WARNING: Could not extract worktree path for $identifier (PID $pid) — orphan cleanup may be needed"
fi
WORKER_WORKTREE[$pid]="$worktree_path"
WORKER_BRANCH[$pid]="$branch_name"
```

Note: timeout increased to 30 seconds to handle slow startup under load. If extraction still fails, a warning is logged so orphaned worktrees can be detected.

### 4. Worktree Cleanup (`reap_workers` and `cleanup`)

After a worker exits (success, failure, or timeout), clean up its worktree. This cleanup block must appear in **both** the timeout branch and the normal-exit branch of `reap_workers`, plus in `cleanup()` (after the force-kill loop, when all processes are guaranteed dead):

```bash
local wt="${WORKER_WORKTREE[$pid]:-}"
local br="${WORKER_BRANCH[$pid]:-}"
if [[ -n "$wt" && -d "$wt" ]]; then
  rm -rf "$wt"
  git -C "$PROJECT_DIR" worktree prune
  if [[ -n "$br" ]]; then
    git -C "$PROJECT_DIR" branch -D "$br" 2>/dev/null || true
  fi
  log "Cleaned up worktree: $wt"
fi
unset "WORKER_WORKTREE[$pid]"
unset "WORKER_BRANCH[$pid]"
```

Note: `git worktree prune` and `git branch -D` use `-C "$PROJECT_DIR"` to ensure they run against the monorepo regardless of the daemon's current working directory.

No changes to `update_status_file()` are needed — the new arrays are internal tracking only.

## Task Flows

### Worker-only task
1. Daemon spawns agent in monorepo worktree
2. Agent inits submodule, creates branch in `packages/worker`
3. Agent makes changes, runs tests on branch
4. Agent checks out main, pulls latest, merges branch
5. Agent runs tests again on merged result
6. Agent pushes to bindify-proxy main
7. Agent waits for CI via `gh run watch --exit-status`
8. Agent bumps submodule ref in monorepo, commits, pushes
9. Daemon cleans up worktree

### Monorepo-only task
1. Daemon spawns agent in monorepo worktree
2. Agent works in monorepo, commits, pushes
3. Daemon cleans up worktree (uniform `rm -rf` handles both cases)

### Cross-repo task
1. Daemon spawns agent in monorepo worktree
2. Agent inits submodule, makes worker changes on branch
3. Agent runs tests, merges to main, pulls latest, runs tests again
4. Agent pushes bindify-proxy main, waits for CI
5. Agent makes monorepo changes, bumps submodule ref, commits, pushes
6. CI deploys everything together in correct order
7. Daemon cleans up worktree

### Bail-out conditions (worker changes)
- Merge conflicts when merging branch to main or pulling latest
- Tests fail after 3 fix attempts
- CI fails on bindify-proxy after push
- Push rejected (e.g. non-fast-forward after another agent pushed)

## What Doesn't Change

- Daemon location: `scripts/linear-daemon.sh` in the monorepo
- Linear polling, issue status management, commenting
- `--worktree`, `--permission-mode bypassPermissions`, stream-json output
- `CLAUDECODE=` env var unset before spawning
- Existing worker tracking (PID, issue ID, identifier, start time)
- MAX_WORKERS, POLL_INTERVAL, WORKER_TIMEOUT
- `update_status_file()` — no changes needed
