-- Temporary migration for rollback testing. Safe to drop.
CREATE TABLE IF NOT EXISTS _rollback_test (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
