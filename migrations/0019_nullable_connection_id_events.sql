-- Make connection_id nullable and add user_id column for orphan events
-- (failed API key validation attempts where no connection is created)

CREATE TABLE connection_events_new (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    user_id TEXT,
    event_type TEXT NOT NULL,
    category TEXT NOT NULL,
    detail TEXT,
    upstream_status INTEGER,
    encrypted_payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO connection_events_new (id, connection_id, event_type, category, detail, upstream_status, encrypted_payload, created_at)
    SELECT id, connection_id, event_type, category, detail, upstream_status, encrypted_payload, created_at
    FROM connection_events;

DROP TABLE connection_events;

ALTER TABLE connection_events_new RENAME TO connection_events;

CREATE INDEX idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
CREATE INDEX idx_connection_events_orphan ON connection_events(created_at) WHERE connection_id IS NULL;
CREATE INDEX idx_connection_events_user_id ON connection_events(user_id) WHERE user_id IS NOT NULL;
