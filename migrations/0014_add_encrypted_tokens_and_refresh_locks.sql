ALTER TABLE connections ADD COLUMN encrypted_tokens TEXT;

CREATE TABLE IF NOT EXISTS refresh_locks (
    connection_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
