-- 0005_add_key_storage_mode.sql
ALTER TABLE connections ADD COLUMN key_storage_mode TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE connections ADD COLUMN last_refreshed_at TEXT;
