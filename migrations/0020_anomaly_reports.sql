CREATE TABLE IF NOT EXISTS anomaly_reports (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    anomaly_type TEXT NOT NULL,
    rectified INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_anomaly_reports_connection_id ON anomaly_reports(connection_id);
CREATE INDEX idx_anomaly_reports_unacknowledged ON anomaly_reports(created_at) WHERE acknowledged_at IS NULL;
