-- Drop stripe_product (no longer used) and add past_due_since.
-- SQLite may not support DROP COLUMN, so we recreate the table.

CREATE TABLE subscriptions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    current_period_end TEXT NOT NULL,
    past_due_since TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO subscriptions_new (id, user_id, quantity, status, current_period_end, created_at)
SELECT id, user_id, quantity, status, current_period_end, created_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
