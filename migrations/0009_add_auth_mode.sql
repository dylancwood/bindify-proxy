-- Add auth_mode column (nullable, null = default/first mode)
ALTER TABLE connections ADD COLUMN auth_mode TEXT;
