CREATE TABLE connection_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  detail TEXT,
  upstream_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
