import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  insertAnomalyReport,
  hasUnacknowledgedAnomaly,
  getUnacknowledgedAnomalyCount,
  getRecentUnacknowledgedAnomalies,
  listAnomalyReports,
  acknowledgeAnomaly,
} from '../db/anomaly-reports';
import { createUser, createConnection } from '../db/queries';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    plan TEXT NOT NULL DEFAULT 'free_trial',
    trial_ends_at TEXT,
    access_until TEXT,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    service TEXT NOT NULL,
    secret_url_segment_1 TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    key_storage_mode TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'oauth',
    auth_mode TEXT,
    application TEXT,
    label TEXT,
    dcr_registration TEXT,
    encrypted_tokens TEXT,
    key_version INTEGER NOT NULL DEFAULT 1,
    key_fingerprint TEXT NOT NULL DEFAULT '',
    managed_key_fingerprint TEXT NOT NULL DEFAULT '',
    dcr_key_fingerprint TEXT NOT NULL DEFAULT '',
    needs_reauth_at TEXT,
    last_used_at TEXT,
    last_refreshed_at TEXT,
    suspended_at TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
`;

const USER_ID = 'anomaly-test-user';
const CONN_ID = 'anomaly-test-conn';
const CONN_ID_2 = 'anomaly-test-conn-2';
const TRIAL_END = '2099-12-31T23:59:59Z';

beforeAll(async () => {
  const statements = SCHEMA.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM anomaly_reports').run();
  await env.DB.prepare('DELETE FROM connections').run();
  await env.DB.prepare('DELETE FROM users').run();

  await createUser(env.DB, USER_ID, TRIAL_END);
  await createConnection(env.DB, {
    id: CONN_ID,
    user_id: USER_ID,
    service: 'github',
    secret_url_segment_1: 'anomaly-secret1',
    status: 'active',
    key_storage_mode: 'zero_knowledge',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    dcr_registration: null,
    needs_reauth_at: null,
  });
  await createConnection(env.DB, {
    id: CONN_ID_2,
    user_id: USER_ID,
    service: 'slack',
    secret_url_segment_1: 'anomaly-secret2',
    status: 'suspended',
    key_storage_mode: 'zero_knowledge',
    auth_type: 'oauth',
    auth_mode: null,
    application: null,
    dcr_registration: null,
    needs_reauth_at: null,
  });
});

describe('insertAnomalyReport', () => {
  it('inserts a report and it can be read back', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'KV entry has no matching D1 row',
    });

    const row = await env.DB.prepare('SELECT * FROM anomaly_reports').first();
    expect(row).toBeTruthy();
    expect(row!.connection_id).toBe(CONN_ID);
    expect(row!.anomaly_type).toBe('kv_orphan');
    expect(row!.rectified).toBe(0);
    expect(row!.detail).toBe('KV entry has no matching D1 row');
    expect(row!.acknowledged_at).toBeNull();
    expect(row!.id).toBeTruthy();
    expect(row!.created_at).toBeTruthy();
  });

  it('inserts a rectified report', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'd1_orphan',
      rectified: true,
      detail: 'Cleaned up orphan D1 row',
    });

    const row = await env.DB.prepare('SELECT * FROM anomaly_reports').first();
    expect(row!.rectified).toBe(1);
  });
});

describe('hasUnacknowledgedAnomaly', () => {
  it('returns true when an unacknowledged anomaly of same type exists', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const result = await hasUnacknowledgedAnomaly(env.DB, CONN_ID, 'kv_orphan');
    expect(result).toBe(true);
  });

  it('returns false when anomaly is of different type', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const result = await hasUnacknowledgedAnomaly(env.DB, CONN_ID, 'd1_orphan');
    expect(result).toBe(false);
  });

  it('returns false when anomaly is acknowledged', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    // Acknowledge it
    const row = await env.DB.prepare('SELECT id FROM anomaly_reports').first<{ id: string }>();
    await acknowledgeAnomaly(env.DB, row!.id);

    const result = await hasUnacknowledgedAnomaly(env.DB, CONN_ID, 'kv_orphan');
    expect(result).toBe(false);
  });

  it('returns false when no anomalies exist', async () => {
    const result = await hasUnacknowledgedAnomaly(env.DB, CONN_ID, 'kv_orphan');
    expect(result).toBe(false);
  });
});

describe('getUnacknowledgedAnomalyCount', () => {
  it('counts unacknowledged anomalies', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test 1',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'd1_orphan',
      rectified: false,
      detail: 'test 2',
    });

    const count = await getUnacknowledgedAnomalyCount(env.DB);
    expect(count).toBe(2);
  });

  it('excludes acknowledged anomalies', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test 1',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'd1_orphan',
      rectified: false,
      detail: 'test 2',
    });

    // Acknowledge the first one
    const row = await env.DB.prepare(
      "SELECT id FROM anomaly_reports WHERE anomaly_type = 'kv_orphan'"
    ).first<{ id: string }>();
    await acknowledgeAnomaly(env.DB, row!.id);

    const count = await getUnacknowledgedAnomalyCount(env.DB);
    expect(count).toBe(1);
  });

  it('returns 0 when no anomalies exist', async () => {
    const count = await getUnacknowledgedAnomalyCount(env.DB);
    expect(count).toBe(0);
  });
});

describe('getRecentUnacknowledgedAnomalies', () => {
  it('returns anomalies with connection info', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const results = await getRecentUnacknowledgedAnomalies(env.DB, 10);
    expect(results).toHaveLength(1);
    expect(results[0].anomaly_type).toBe('kv_orphan');
    expect(results[0].connection_service).toBe('github');
    expect(results[0].connection_status).toBe('active');
  });

  it('returns results ordered by created_at DESC', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'first',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID_2,
      anomalyType: 'd1_orphan',
      rectified: false,
      detail: 'second',
    });

    const results = await getRecentUnacknowledgedAnomalies(env.DB, 10);
    expect(results).toHaveLength(2);
    expect(results[0].detail).toBe('second');
    expect(results[1].detail).toBe('first');
  });

  it('excludes acknowledged anomalies', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const row = await env.DB.prepare('SELECT id FROM anomaly_reports').first<{ id: string }>();
    await acknowledgeAnomaly(env.DB, row!.id);

    const results = await getRecentUnacknowledgedAnomalies(env.DB, 10);
    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAnomalyReport(env.DB, {
        connectionId: CONN_ID,
        anomalyType: 'kv_orphan',
        rectified: false,
        detail: `test ${i}`,
      });
    }

    const results = await getRecentUnacknowledgedAnomalies(env.DB, 3);
    expect(results).toHaveLength(3);
  });
});

describe('listAnomalyReports', () => {
  it('returns paginated results', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAnomalyReport(env.DB, {
        connectionId: CONN_ID,
        anomalyType: 'kv_orphan',
        rectified: false,
        detail: `test ${i}`,
      });
    }

    const result = await listAnomalyReports(env.DB, { page: 1, limit: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.limit).toBe(2);
    expect(result.pagination.total).toBe(5);
    expect(result.pagination.total_pages).toBe(3);
  });

  it('returns page 2 correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAnomalyReport(env.DB, {
        connectionId: CONN_ID,
        anomalyType: 'kv_orphan',
        rectified: false,
        detail: `test ${i}`,
      });
    }

    const result = await listAnomalyReports(env.DB, { page: 2, limit: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.pagination.page).toBe(2);
  });

  it('filters by anomaly_type', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'kv issue',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'd1_orphan',
      rectified: false,
      detail: 'd1 issue',
    });

    const result = await listAnomalyReports(env.DB, { anomaly_type: 'kv_orphan' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].anomaly_type).toBe('kv_orphan');
    expect(result.pagination.total).toBe(1);
  });

  it('filters by rectified', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'not fixed',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: true,
      detail: 'fixed',
    });

    const result = await listAnomalyReports(env.DB, { rectified: true });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].detail).toBe('fixed');
  });

  it('filters by acknowledged', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'unacked',
    });
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'd1_orphan',
      rectified: false,
      detail: 'acked',
    });

    // Acknowledge the second one
    const row = await env.DB.prepare(
      "SELECT id FROM anomaly_reports WHERE anomaly_type = 'd1_orphan'"
    ).first<{ id: string }>();
    await acknowledgeAnomaly(env.DB, row!.id);

    const unacked = await listAnomalyReports(env.DB, { acknowledged: false });
    expect(unacked.data).toHaveLength(1);
    expect(unacked.data[0].detail).toBe('unacked');

    const acked = await listAnomalyReports(env.DB, { acknowledged: true });
    expect(acked.data).toHaveLength(1);
    expect(acked.data[0].detail).toBe('acked');
  });

  it('includes connection info via LEFT JOIN', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID_2,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const result = await listAnomalyReports(env.DB, {});
    expect(result.data).toHaveLength(1);
    expect(result.data[0].connection_service).toBe('slack');
    expect(result.data[0].connection_status).toBe('suspended');
  });

  it('caps limit at 100', async () => {
    const result = await listAnomalyReports(env.DB, { limit: 200 });
    expect(result.pagination.limit).toBe(100);
  });
});

describe('acknowledgeAnomaly', () => {
  it('sets acknowledged_at timestamp', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const row = await env.DB.prepare('SELECT id FROM anomaly_reports').first<{ id: string }>();
    const result = await acknowledgeAnomaly(env.DB, row!.id);
    expect(result).toBe(true);

    const updated = await env.DB.prepare('SELECT acknowledged_at FROM anomaly_reports WHERE id = ?')
      .bind(row!.id)
      .first<{ acknowledged_at: string }>();
    expect(updated!.acknowledged_at).toBeTruthy();
  });

  it('returns false for non-existent id', async () => {
    const result = await acknowledgeAnomaly(env.DB, 'non-existent-id');
    expect(result).toBe(false);
  });

  it('returns false when already acknowledged', async () => {
    await insertAnomalyReport(env.DB, {
      connectionId: CONN_ID,
      anomalyType: 'kv_orphan',
      rectified: false,
      detail: 'test',
    });

    const row = await env.DB.prepare('SELECT id FROM anomaly_reports').first<{ id: string }>();
    await acknowledgeAnomaly(env.DB, row!.id);

    // Try to acknowledge again
    const result = await acknowledgeAnomaly(env.DB, row!.id);
    expect(result).toBe(false);
  });
});
