# Cross-Repo Linear Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the Linear daemon to support tasks spanning the monorepo and the bindify-proxy worker repo, with CI gating and automated worktree cleanup.

**Architecture:** Five changes across two files: four additive changes to `linear-daemon.sh` ((1) new tracking arrays, (2) worktree path extraction, (3) worktree cleanup, (4) cross-repo prompt section) plus (5) a CI verification reminder in the monorepo's `AGENT.md`.

**Tech Stack:** Bash 4+, jq, git, gh CLI

**Spec:** `docs/superpowers/specs/2026-03-17-cross-repo-daemon-design.md`

---

### Task 1: Add Worktree Tracking Arrays

**Files:**
- Modify: `/Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh:39-44`

- [ ] **Step 1: Add new tracking arrays after existing ones**

At line 43, after `declare -A WORKER_START_TIME=()`, add:

```bash
declare -A WORKER_WORKTREE=()    # PID → worktree directory path
declare -A WORKER_BRANCH=()      # PID → worktree branch name
```

- [ ] **Step 2: Verify script still parses**

Run: `bash -n /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: no output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
cd /Users/dwood/Documents/github/bindify
git add scripts/linear-daemon.sh
git commit -m "feat(daemon): add worktree tracking arrays"
```

---

### Task 2: Extract Worktree Path After Spawning

**Files:**
- Modify: `/Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh:235-268` (the `spawn_worker` function)

- [ ] **Step 1: Add worktree extraction logic to `spawn_worker`**

After line 267 (`update_status_file`), before the closing `}` of `spawn_worker`, add:

```bash
  # Extract worktree path from stream-json init event
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

- [ ] **Step 2: Verify script still parses**

Run: `bash -n /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: no output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
cd /Users/dwood/Documents/github/bindify
git add scripts/linear-daemon.sh
git commit -m "feat(daemon): extract worktree path from stream-json after spawning"
```

---

### Task 3: Add Worktree Cleanup to `reap_workers` and `cleanup`

**Files:**
- Modify: `/Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh:270-369` (the `reap_workers` and `cleanup` functions)

- [ ] **Step 1: Create a `cleanup_worktree` helper function**

Add this new function after `worker_count()` (after line 324) and before `cleanup()`:

```bash
cleanup_worktree() {
  local pid="$1"
  local wt="${WORKER_WORKTREE[$pid]:-}"
  local br="${WORKER_BRANCH[$pid]:-}"
  if [[ -n "$wt" && -d "$wt" && "$wt" == "$PROJECT_DIR"/.claude/worktrees/* ]]; then
    rm -rf "$wt"
    git -C "$PROJECT_DIR" worktree prune
    if [[ -n "$br" ]]; then
      git -C "$PROJECT_DIR" branch -D "$br" 2>/dev/null || true
    fi
    log "Cleaned up worktree: $wt"
  fi
  unset "WORKER_WORKTREE[$pid]"
  unset "WORKER_BRANCH[$pid]"
}
```

- [ ] **Step 2: Call `cleanup_worktree` in the timeout branch of `reap_workers`**

In `reap_workers`, in the timeout branch (after the line `unset "WORKER_START_TIME[$pid]"` around line 295), add before `update_status_file`:

```bash
        cleanup_worktree "$pid"
```

- [ ] **Step 3: Call `cleanup_worktree` in the normal-exit branch of `reap_workers`**

In `reap_workers`, in the normal-exit branch (after the line `unset "WORKER_START_TIME[$pid]"` around line 316), add before `update_status_file`:

```bash
      cleanup_worktree "$pid"
```

- [ ] **Step 4: Call `cleanup_worktree` in the `cleanup` shutdown function**

In `cleanup()`, after the force-kill loop (after line 364, the closing `done` of the force-kill loop), add before `rm -f "$STATUS_FILE"`:

```bash
  # Clean up all worktrees
  for pid in "${!WORKER_WORKTREE[@]}"; do
    cleanup_worktree "$pid"
  done
```

- [ ] **Step 5: Verify script still parses**

Run: `bash -n /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: no output (no syntax errors)

- [ ] **Step 6: Commit**

```bash
cd /Users/dwood/Documents/github/bindify
git add scripts/linear-daemon.sh
git commit -m "feat(daemon): add worktree cleanup on worker exit and shutdown"
```

---

### Task 4: Add Cross-Repo Prompt Section to `build_prompt`

**Files:**
- Modify: `/Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh:178-233` (the `build_prompt` function)

- [ ] **Step 1: Add cross-repo section to the prompt**

In `build_prompt`, before the closing `PROMPT` heredoc delimiter (line 232), add the following new section:

```
## Cross-Repo Work (Worker / bindify-proxy)

The API worker source is at \`packages/worker/\` (a git submodule pointing to bindify-proxy).
If your task requires changes to the worker:

1. Run: \`git submodule update --init packages/worker\`
2. \`cd packages/worker\` and create a branch: \`git checkout -b $identifier-slug\`
3. Make your changes and commit them on the branch
4. Run tests: \`npm test\` — bail out if they fail after 3 fix attempts
5. Merge to main and pull latest:
   - \`git checkout main && git pull origin main\`
   - \`git merge $identifier-slug\`
   - If merge conflicts: bail out, comment on the Linear issue, move to Todo
6. Run tests again against the merged result — bail out if they fail
7. Push: \`git push origin main\`
8. Wait for CI: \`gh run watch --exit-status\`
   - If CI fails: bail out, comment on the Linear issue, move to Todo
9. \`cd\` back to the monorepo root
10. \`git add packages/worker\` to update the submodule ref
11. Include the submodule bump in your monorepo commit

If the task ONLY affects the worker and not the monorepo, you still need to
bump the submodule so deployment picks it up.

Read \`AGENT.md\` (monorepo root) for deployment and cross-repo details.
After step 1, read \`packages/worker/AGENT.md\` for worker-specific context.
```

Note: backticks must be escaped with `\` inside the heredoc since `build_prompt` uses an unquoted heredoc delimiter (`PROMPT` not `'PROMPT'`), which means the shell will interpret backticks as command substitution. The `$identifier` variable in the branch name is intentional — it will expand to the issue identifier (e.g. `BIN-170`).

- [ ] **Step 2: Add worker-specific bail-out conditions**

In the "Bail-Out Conditions" section of the prompt (around line 226-231), add these lines before the closing `PROMPT`:

```
- Worker CI fails after push to bindify-proxy
- Push to bindify-proxy rejected (non-fast-forward)
```

- [ ] **Step 3: Verify script still parses**

Run: `bash -n /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: no output (no syntax errors)

- [ ] **Step 4: Smoke test the prompt output**

Run: `cd /Users/dwood/Documents/github/bindify && bash -c 'source scripts/linear-daemon.sh 2>/dev/null; build_prompt "BIN-999" "Test issue" "Test description"' 2>/dev/null || true`

This won't work directly since the script sources .env and runs CLI dispatch. Instead, verify manually:

Run: `grep -c "Cross-Repo Work" /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: `1`

Run: `grep -c "gh run watch" /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: `1`

- [ ] **Step 5: Commit**

```bash
cd /Users/dwood/Documents/github/bindify
git add scripts/linear-daemon.sh
git commit -m "feat(daemon): add cross-repo worker instructions to agent prompt"
```

---

### Task 5: Add CI Verification to Monorepo AGENT.md

**Files:**
- Modify: `/Users/dwood/Documents/github/bindify/AGENT.md`

- [ ] **Step 1: Add CI verification instruction to the Worker submodule section**

In the "Pulling in worker changes" section of AGENT.md, add after the code block showing the bump commands:

Add the following text after the bump code block:

````
**Before bumping the submodule**, verify that the target commit has passed CI in GitHub:

```bash
cd packages/worker
gh run list --commit $(git rev-parse HEAD) --json status,conclusion --jq '.[0]'
```

Only bump and push if the latest CI run shows `"conclusion": "success"`. If CI is still running, wait with `gh run watch --exit-status`.
````

- [ ] **Step 2: Verify the change reads correctly**

Run: `grep -A5 "Before bumping" /Users/dwood/Documents/github/bindify/AGENT.md`
Expected: the CI verification instruction is present.

- [ ] **Step 3: Commit**

```bash
cd /Users/dwood/Documents/github/bindify
git add AGENT.md
git commit -m "docs: add CI verification step before submodule bump"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Full syntax check**

Run: `bash -n /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`
Expected: no output

- [ ] **Step 2: Verify all four features are present**

Run: `grep -n "WORKER_WORKTREE\|WORKER_BRANCH\|cleanup_worktree\|Cross-Repo Work\|gh run watch" /Users/dwood/Documents/github/bindify/scripts/linear-daemon.sh`

Expected: hits for all five patterns across the file.

- [ ] **Step 3: Verify no unintended changes**

Run: `cd /Users/dwood/Documents/github/bindify && git diff main --stat`

Expected: only `scripts/linear-daemon.sh` and `AGENT.md` changed.
