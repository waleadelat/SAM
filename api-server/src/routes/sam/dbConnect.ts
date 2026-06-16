/**
 * Routes for connecting to an external SQL Server / Azure SQL database and
 * loading a table/view as the session dataset.
 *
 * POST /sessions/:sessionId/db-connect
 *   Body: { connectionString: string }
 *   Returns: { tables: string[], server: string, database: string }
 *
 * POST /sessions/:sessionId/db-load
 *   Body: { connectionString: string, table: string }
 *   Returns: same shape as /upload
 */
import { Router } from "express";
import sql from "mssql";
import {
  getSession,
  setSessionUpload,
  clearSessionState,
  type SessionUpload,
  type ParsedRow,
} from "../../lib/sessionStore.js";
import {
  parseMssqlConnectionString,
  maskConnectionString,
  connectionLabel,
} from "../../lib/mssqlParser.js";

const router = Router();

const ROW_CAP = 100_000;
const CONNECT_TIMEOUT_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("login failed") || lower.includes("password") || lower.includes("authentication"))
    return "Authentication failed. Check your username and password.";
  if (lower.includes("network") || lower.includes("connect") || lower.includes("timeout") || lower.includes("econnrefused"))
    return "Could not reach the server. Check the server address, port, and firewall rules.";
  if (lower.includes("database") && lower.includes("not found"))
    return "Database not found. Check the database name in the connection string.";
  return `Connection error: ${msg}`;
}

async function openPool(connectionString: string): Promise<sql.ConnectionPool> {
  const cfg = parseMssqlConnectionString(connectionString);
  if (!cfg) {
    throw new Error("Could not parse connection string. Make sure it is in ADO.NET format.");
  }
  const pool = new sql.ConnectionPool({
    ...cfg,
    options: {
      ...(cfg.options as object),
      connectTimeout: CONNECT_TIMEOUT_MS,
    },
  });
  await pool.connect();
  return pool;
}

function coerceValue(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return val;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  const n = Number(val);
  return isNaN(n) ? String(val) : n;
}

function detectNumericColumns(rows: ParsedRow[], columns: string[]): string[] {
  return columns.filter((col) => {
    let numericCount = 0;
    let nonNullCount = 0;
    for (const row of rows.slice(0, 100)) {
      const val = row[col];
      if (val !== null && val !== undefined) {
        nonNullCount++;
        if (typeof val === "number") numericCount++;
      }
    }
    return nonNullCount > 0 && numericCount / nonNullCount > 0.8;
  });
}

// ── POST /sessions/:sessionId/db-connect ─────────────────────────────────────

router.post("/sessions/:sessionId/db-connect", async (req, res) => {
  const sessionId = req.params["sessionId"] as string;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { connectionString } = req.body as { connectionString?: string };
  if (!connectionString || typeof connectionString !== "string" || !connectionString.trim()) {
    res.status(400).json({ error: "connectionString is required." });
    return;
  }

  let pool: sql.ConnectionPool | null = null;
  try {
    pool = await openPool(connectionString);

    const result = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);

    const tables: string[] = result.recordset.map((r: any) =>
      r.TABLE_SCHEMA && r.TABLE_SCHEMA !== "dbo"
        ? `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`
        : r.TABLE_NAME
    );

    const label = connectionLabel(connectionString);
    const [server, database] = label.split(" / ");

    res.json({ tables, server: server ?? "", database: database ?? "" });
  } catch (err) {
    const friendly = classifyError(err);
    res.status(400).json({ error: friendly });
  } finally {
    pool?.close().catch(() => {});
  }
});

// ── POST /sessions/:sessionId/db-load ────────────────────────────────────────

router.post("/sessions/:sessionId/db-load", async (req, res) => {
  const sessionId = req.params["sessionId"] as string;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { connectionString, table } = req.body as {
    connectionString?: string;
    table?: string;
  };

  if (!connectionString || typeof connectionString !== "string" || !connectionString.trim()) {
    res.status(400).json({ error: "connectionString is required." });
    return;
  }
  if (!table || typeof table !== "string" || !table.trim()) {
    res.status(400).json({ error: "table is required." });
    return;
  }

  // Validate table name to prevent SQL injection (schema.table or table only)
  const tablePattern = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
  if (!tablePattern.test(table.trim())) {
    res.status(400).json({ error: "Invalid table name." });
    return;
  }

  let pool: sql.ConnectionPool | null = null;
  try {
    pool = await openPool(connectionString);

    // Count rows first
    const countResult = await pool
      .request()
      .query(`SELECT COUNT(*) AS cnt FROM [${table.replace(".", "].[").replace(/\[/g, "[").replace(/\]/g, "]")}]`);
    const rowCount: number = countResult.recordset[0]?.cnt ?? 0;

    if (rowCount > ROW_CAP) {
      res.status(400).json({
        error: `Table has ${rowCount.toLocaleString()} rows which exceeds the ${ROW_CAP.toLocaleString()}-row limit. Apply a filter or choose a smaller table/view.`,
      });
      return;
    }

    const dataResult = await pool
      .request()
      .query(`SELECT TOP ${ROW_CAP} * FROM [${table.replace(".", "].[").replace(/\[/g, "[").replace(/\]/g, "]")}]`);

    const rawRows: Record<string, unknown>[] = dataResult.recordset;
    const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    const data: ParsedRow[] = rawRows.map((raw) => {
      const row: ParsedRow = {};
      for (const col of columns) row[col] = coerceValue(raw[col]);
      return row;
    });

    const numericColumns = detectNumericColumns(data, columns);

    const upload: SessionUpload = {
      fileName: `${table} (SQL)`,
      rowCount: data.length,
      columns,
      numericColumns,
      data,
    };

    await setSessionUpload(sessionId, upload);
    await clearSessionState(sessionId);

    res.json({
      sessionId,
      fileName: upload.fileName,
      rowCount: upload.rowCount,
      columns: upload.columns,
      numericColumns: upload.numericColumns,
      sampleRows: data.slice(0, 5),
    });
  } catch (err) {
    if (res.headersSent) return;
    const friendly = classifyError(err);
    res.status(400).json({ error: friendly });
  } finally {
    pool?.close().catch(() => {});
  }
});

export default router;
