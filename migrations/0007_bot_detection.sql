-- 0007_bot_detection.sql
-- Bot detection: 404 logging and IP blocklist

CREATE TABLE proxy_404_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ip            TEXT    NOT NULL,
  url_segment   TEXT    NOT NULL,
  headers       TEXT,
  timestamp     INTEGER NOT NULL,
  asn           TEXT,
  asn_org       TEXT,
  country       TEXT,
  processed     INTEGER DEFAULT 0
);

CREATE INDEX idx_404_ip_time   ON proxy_404_log(ip, timestamp);
CREATE INDEX idx_404_processed ON proxy_404_log(processed, timestamp);

CREATE TABLE ip_blocklist (
  ip            TEXT    PRIMARY KEY,
  reason        TEXT,
  asn_org       TEXT,
  blocked_at    INTEGER,
  expires_at    INTEGER,
  block_count   INTEGER DEFAULT 1
);
