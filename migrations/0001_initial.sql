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
    secret_url_segment_2 TEXT UNIQUE NOT NULL,
    api_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    kv_token_key TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    stripe_product TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    current_period_end TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_secret_1 ON connections(secret_url_segment_1);
CREATE INDEX IF NOT EXISTS idx_connections_api_key ON connections(api_key);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
