CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    plan TEXT NOT NULL DEFAULT 'free_trial',
    trial_ends_at TEXT,
    access_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    service TEXT NOT NULL,
    secret_url_segment_1 TEXT UNIQUE NOT NULL,
    -- secret_url_segment_2: REMOVED — never stored (zero-knowledge)
    -- api_key: REMOVED — never stored (contains secret2)
    status TEXT NOT NULL DEFAULT 'active',
    key_storage_mode TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'oauth',
    auth_mode TEXT,
    application TEXT,
    dcr_registration TEXT,
    encrypted_tokens TEXT,
    key_version INTEGER NOT NULL DEFAULT 1,
    needs_reauth_at TEXT,
    last_used_at TEXT,
    last_refreshed_at TEXT,
    suspended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    current_period_end TEXT NOT NULL,
    past_due_since TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_events (
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

CREATE TABLE IF NOT EXISTS refresh_locks (
    connection_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_events_lookup ON connection_events(connection_id, event_type, category, created_at);
CREATE INDEX IF NOT EXISTS idx_connection_events_orphan ON connection_events(created_at) WHERE connection_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_connection_events_user_id ON connection_events(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS anomaly_reports (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    anomaly_type TEXT NOT NULL,
    rectified INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_anomaly_reports_connection_id ON anomaly_reports(connection_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_reports_unacknowledged ON anomaly_reports(created_at) WHERE acknowledged_at IS NULL;
