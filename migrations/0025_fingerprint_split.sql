-- BIN-369: Split key_fingerprint into managed_key_fingerprint and dcr_key_fingerprint
ALTER TABLE connections ADD COLUMN managed_key_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN dcr_key_fingerprint TEXT NOT NULL DEFAULT '';

-- Backfill: managed connections get managed_key_fingerprint from key_fingerprint
UPDATE connections SET managed_key_fingerprint = key_fingerprint
  WHERE key_storage_mode = 'managed';

-- Backfill: all connections with DCR get dcr_key_fingerprint from key_fingerprint
UPDATE connections SET dcr_key_fingerprint = key_fingerprint
  WHERE dcr_registration IS NOT NULL;

-- Indexes for rotation queries
CREATE INDEX idx_connections_managed_key_fp
  ON connections(key_storage_mode, managed_key_fingerprint);

CREATE INDEX idx_connections_dcr_key_fp
  ON connections(dcr_key_fingerprint) WHERE dcr_registration IS NOT NULL;
