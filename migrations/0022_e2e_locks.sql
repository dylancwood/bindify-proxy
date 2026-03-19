-- E2E test lock: prevents concurrent test runs from clobbering the shared staging database.
-- Single-row table. TTL-based expiry (25 min) handles crash recovery.
CREATE TABLE IF NOT EXISTS e2e_locks (
    id TEXT PRIMARY KEY DEFAULT 'e2e_run',
    locked_by TEXT NOT NULL,
    branch TEXT,
    github_run_id TEXT,
    locked_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
