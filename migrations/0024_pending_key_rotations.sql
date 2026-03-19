-- BIN-275: Table for rotation communication between script and worker cron
CREATE TABLE pending_key_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expected_fingerprints TEXT NOT NULL,
  new_key_hex TEXT NOT NULL,
  new_key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
