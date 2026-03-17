-- 0008_interest_log.sql
-- Interest logging for "coming soon" features

CREATE TABLE interest_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service    TEXT    NOT NULL,
  user_id    TEXT,
  ip         TEXT,
  created_at TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX idx_interest_log_service ON interest_log(service);
