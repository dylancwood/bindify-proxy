-- 0015_bot_detection_secret_segment.sql
-- Add raw URL and extracted secret segment to 404 log for hardened bot classification

ALTER TABLE proxy_404_log ADD COLUMN raw_url TEXT;
ALTER TABLE proxy_404_log ADD COLUMN secret_segment TEXT;
