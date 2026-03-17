export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; total_pages: number };
}

export interface AnomalyReportInput {
  connectionId: string;
  anomalyType: string;
  rectified: boolean;
  detail: string;
}

export interface AnomalyReportRow {
  id: string;
  connection_id: string;
  anomaly_type: string;
  rectified: number; // SQLite boolean
  detail: string | null;
  acknowledged_at: string | null;
  created_at: string;
  connection_service?: string;
  connection_status?: string;
}

export interface ListAnomalyReportsParams {
  anomaly_type?: string;
  rectified?: boolean;
  acknowledged?: boolean;
  page?: number;
  limit?: number;
}

export async function insertAnomalyReport(db: D1Database, input: AnomalyReportInput): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO anomaly_reports (id, connection_id, anomaly_type, rectified, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, input.connectionId, input.anomalyType, input.rectified ? 1 : 0, input.detail)
    .run();
}

export async function hasUnacknowledgedAnomaly(
  db: D1Database,
  connectionId: string,
  anomalyType: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM anomaly_reports
       WHERE connection_id = ? AND anomaly_type = ? AND acknowledged_at IS NULL
       LIMIT 1`
    )
    .bind(connectionId, anomalyType)
    .first();
  return row !== null;
}

export async function getUnacknowledgedAnomalyCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM anomaly_reports WHERE acknowledged_at IS NULL`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getRecentUnacknowledgedAnomalies(
  db: D1Database,
  limit: number
): Promise<AnomalyReportRow[]> {
  const result = await db
    .prepare(
      `SELECT ar.*, c.service as connection_service, c.status as connection_status
       FROM anomaly_reports ar
       LEFT JOIN connections c ON ar.connection_id = c.id
       WHERE ar.acknowledged_at IS NULL
       ORDER BY ar.created_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<AnomalyReportRow>();
  return result.results;
}

export async function listAnomalyReports(
  db: D1Database,
  params: ListAnomalyReportsParams
): Promise<PaginatedResult<AnomalyReportRow>> {
  const page = params.page ?? 1;
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (params.anomaly_type !== undefined) {
    conditions.push('ar.anomaly_type = ?');
    bindings.push(params.anomaly_type);
  }

  if (params.rectified !== undefined) {
    conditions.push('ar.rectified = ?');
    bindings.push(params.rectified ? 1 : 0);
  }

  if (params.acknowledged !== undefined) {
    if (params.acknowledged) {
      conditions.push('ar.acknowledged_at IS NOT NULL');
    } else {
      conditions.push('ar.acknowledged_at IS NULL');
    }
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM anomaly_reports ar ${whereClause}`)
    .bind(...bindings)
    .first<{ count: number }>();
  const total = countResult?.count ?? 0;

  const result = await db
    .prepare(
      `SELECT ar.*, c.service as connection_service, c.status as connection_status
       FROM anomaly_reports ar
       LEFT JOIN connections c ON ar.connection_id = c.id
       ${whereClause}
       ORDER BY ar.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...bindings, limit, offset)
    .all<AnomalyReportRow>();

  return {
    data: result.results,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function acknowledgeAnomaly(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE anomaly_reports SET acknowledged_at = datetime('now')
       WHERE id = ? AND acknowledged_at IS NULL`
    )
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
