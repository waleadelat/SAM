/**
 * Azure SQL-backed session store.
 *
 * Schema is created on first use (IF NOT EXISTS).
 * All operations mirror the in-memory sessionStore API exactly so the
 * calling code never needs to know which backend is active.
 */
import sql from "mssql";
import { randomUUID } from "node:crypto";
import { parseMssqlConnectionString } from "./mssqlParser.js";
import type {
  Session,
  SessionUpload,
  StoredMessage,
  AnalysisConfig,
} from "./sessionStore.js";

let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const cs = process.env["AZURE_SQL_CONNECTION_STRING"];
  if (!cs) throw new Error("AZURE_SQL_CONNECTION_STRING is not set");
  const cfg = parseMssqlConnectionString(cs);
  if (!cfg) throw new Error("Could not parse AZURE_SQL_CONNECTION_STRING");
  pool = await new sql.ConnectionPool(cfg).connect();
  return pool;
}

// ── Schema bootstrap ────────────────────────────────────────────────────────

const SCHEMA_SQL = `
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='sam_sessions')
CREATE TABLE sam_sessions (
  session_id   NVARCHAR(36)  NOT NULL PRIMARY KEY,
  created_at   DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
  upload_json  NVARCHAR(MAX) NULL,
  latest_analysis_json NVARCHAR(MAX) NULL,
  analysis_config_json NVARCHAR(MAX) NULL,
  generated_charts_json NVARCHAR(MAX) NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='sam_messages')
CREATE TABLE sam_messages (
  id           NVARCHAR(36)  NOT NULL PRIMARY KEY,
  session_id   NVARCHAR(36)  NOT NULL,
  role         NVARCHAR(16)  NOT NULL,
  content      NVARCHAR(MAX) NOT NULL,
  analysis_json NVARCHAR(MAX) NULL,
  created_at   DATETIME2     NOT NULL DEFAULT GETUTCDATE()
);
`;

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const p = await getPool();
  await p.request().query(SCHEMA_SQL);
  schemaReady = true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToSession(row: any): Session {
  return {
    sessionId: row.session_id,
    createdAt: new Date(row.created_at),
    upload: row.upload_json ? JSON.parse(row.upload_json) : null,
    messages: [],
    latestAnalysis: row.latest_analysis_json ? JSON.parse(row.latest_analysis_json) : null,
    analysisConfig: row.analysis_config_json ? JSON.parse(row.analysis_config_json) : null,
    generatedCharts: row.generated_charts_json ? JSON.parse(row.generated_charts_json) : [],
  };
}

// ── Public API (mirrors sessionStore.ts) ───────────────────────────────────

export async function createSession(): Promise<Session> {
  await ensureSchema();
  const p = await getPool();
  const sessionId = randomUUID();
  await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query(
      "INSERT INTO sam_sessions (session_id) VALUES (@session_id)"
    );
  return {
    sessionId,
    createdAt: new Date(),
    upload: null,
    messages: [],
    latestAnalysis: null,
    analysisConfig: null,
    generatedCharts: [],
  };
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  await ensureSchema();
  const p = await getPool();
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query("SELECT * FROM sam_sessions WHERE session_id = @session_id");
  if (!result.recordset.length) return undefined;
  const session = rowToSession(result.recordset[0]);

  const msgs = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query(
      "SELECT * FROM sam_messages WHERE session_id = @session_id ORDER BY created_at ASC"
    );
  session.messages = msgs.recordset.map((r: any) => ({
    id: r.id,
    role: r.role as "user" | "assistant",
    content: r.content,
    analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null,
    createdAt: new Date(r.created_at),
  }));
  return session;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query("DELETE FROM sam_messages WHERE session_id = @session_id");
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query("DELETE FROM sam_sessions WHERE session_id = @session_id");
  return (result.rowsAffected[0] ?? 0) > 0;
}

export async function addMessage(
  sessionId: string,
  msg: Omit<StoredMessage, "id" | "createdAt">
): Promise<StoredMessage | null> {
  await ensureSchema();
  const p = await getPool();
  const sessionCheck = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query("SELECT 1 FROM sam_sessions WHERE session_id = @session_id");
  if (!sessionCheck.recordset.length) return null;

  const id = randomUUID();
  await p
    .request()
    .input("id", sql.NVarChar(36), id)
    .input("session_id", sql.NVarChar(36), sessionId)
    .input("role", sql.NVarChar(16), msg.role)
    .input("content", sql.NVarChar(sql.MAX), msg.content)
    .input(
      "analysis_json",
      sql.NVarChar(sql.MAX),
      msg.analysis != null ? JSON.stringify(msg.analysis) : null
    )
    .query(
      "INSERT INTO sam_messages (id, session_id, role, content, analysis_json) VALUES (@id, @session_id, @role, @content, @analysis_json)"
    );
  return { ...msg, id, createdAt: new Date() };
}

export async function updateAnalysisConfig(
  sessionId: string,
  config: AnalysisConfig
): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .input("config", sql.NVarChar(sql.MAX), JSON.stringify(config))
    .query(
      "UPDATE sam_sessions SET analysis_config_json = @config WHERE session_id = @session_id"
    );
  return (result.rowsAffected[0] ?? 0) > 0;
}

export async function addGeneratedChart(
  sessionId: string,
  base64Png: string
): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  const current = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query(
      "SELECT generated_charts_json FROM sam_sessions WHERE session_id = @session_id"
    );
  if (!current.recordset.length) return false;
  const charts: string[] = current.recordset[0].generated_charts_json
    ? JSON.parse(current.recordset[0].generated_charts_json)
    : [];
  charts.push(base64Png);
  await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .input("charts", sql.NVarChar(sql.MAX), JSON.stringify(charts))
    .query(
      "UPDATE sam_sessions SET generated_charts_json = @charts WHERE session_id = @session_id"
    );
  return true;
}

export async function setSessionUpload(
  sessionId: string,
  upload: SessionUpload | null
): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .input(
      "upload",
      sql.NVarChar(sql.MAX),
      upload != null ? JSON.stringify(upload) : null
    )
    .query(
      "UPDATE sam_sessions SET upload_json = @upload WHERE session_id = @session_id"
    );
  return (result.rowsAffected[0] ?? 0) > 0;
}

export async function setLatestAnalysis(
  sessionId: string,
  analysis: Record<string, unknown> | null
): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .input(
      "analysis",
      sql.NVarChar(sql.MAX),
      analysis != null ? JSON.stringify(analysis) : null
    )
    .query(
      "UPDATE sam_sessions SET latest_analysis_json = @analysis WHERE session_id = @session_id"
    );
  return (result.rowsAffected[0] ?? 0) > 0;
}

export async function clearSessionState(sessionId: string): Promise<boolean> {
  await ensureSchema();
  const p = await getPool();
  const result = await p
    .request()
    .input("session_id", sql.NVarChar(36), sessionId)
    .query(
      `UPDATE sam_sessions
       SET latest_analysis_json = NULL, analysis_config_json = NULL, generated_charts_json = NULL
       WHERE session_id = @session_id`
    );
  return (result.rowsAffected[0] ?? 0) > 0;
}
