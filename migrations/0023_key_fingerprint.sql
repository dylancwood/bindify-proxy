-- BIN-275: Replace integer key_version with fingerprint-based key_fingerprint
-- Note: SQLite does not support DROP COLUMN in older versions. We add the new column
-- and leave key_version as a no-op. The application code ignores key_version going forward.
ALTER TABLE connections ADD COLUMN key_fingerprint TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_connections_key_fingerprint ON connections(key_storage_mode, key_fingerprint);
