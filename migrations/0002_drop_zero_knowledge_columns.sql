-- Remove secret_url_segment_2 and api_key from connections table.
-- These are no longer stored (zero-knowledge design: secret2 never persisted).
-- SQLite doesn't support DROP COLUMN before 3.35.0, so we recreate the table.

CREATE TABLE connections_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    service TEXT NOT NULL,
    secret_url_segment_1 TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    kv_token_key TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO connections_new (id, user_id, service, secret_url_segment_1, status, kv_token_key, last_used_at, created_at)
SELECT id, user_id, service, secret_url_segment_1, status, kv_token_key, last_used_at, created_at
FROM connections;

DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
