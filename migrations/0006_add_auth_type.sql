-- Migration: Add auth_type column to connections table
-- Supports API key authentication alongside OAuth
ALTER TABLE connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth';
