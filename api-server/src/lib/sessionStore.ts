import { randomUUID } from "node:crypto";

export interface ParsedRow {
  [column: string]: string | number | null;
}

export interface SessionUpload {
  fileName: string;
  rowCount: number;
  columns: string[];
  numericColumns: string[];
  data: ParsedRow[];
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  analysis?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AnalysisConfig {
  assetType: string;
  conditionColumn: string;
  scale: "scale_0_100" | "nbi_0_9" | "pci_0_100" | "scale_0_10";
}

export interface Session {
  sessionId: string;
  createdAt: Date;
  upload: SessionUpload | null;
  messages: StoredMessage[];
  latestAnalysis: Record<string, unknown> | null;
  analysisConfig: AnalysisConfig | null;
  generatedCharts: string[];
}

// ── Backend detection ────────────────────────────────────────────────────────
// If AZURE_SQL_CONNECTION_STRING is set, all writes go to Azure SQL and reads
// come from Azure SQL. Otherwise we fall back to the in-memory map (dev mode).

const USE_SQL = !!process.env["AZURE_SQL_CONNECTION_STRING"];

// ── In-memory store (default / dev fallback) ────────────────────────────────

const sessions = new Map<string, Session>();

function memCreateSession(): Session {
  const session: Session = {
    sessionId: randomUUID(),
    createdAt: new Date(),
    upload: null,
    messages: [],
    latestAnalysis: null,
    analysisConfig: null,
    generatedCharts: [],
  };
  sessions.set(session.sessionId, session);
  return session;
}

function memGetSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

function memDeleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

function memAddMessage(
  sessionId: string,
  msg: Omit<StoredMessage, "id" | "createdAt">
): StoredMessage | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const stored: StoredMessage = {
    ...msg,
    id: randomUUID(),
    createdAt: new Date(),
  };
  session.messages.push(stored);
  return stored;
}

function memUpdateAnalysisConfig(sessionId: string, config: AnalysisConfig): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.analysisConfig = config;
  return true;
}

function memAddGeneratedChart(sessionId: string, base64Png: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.generatedCharts.push(base64Png);
  return true;
}

// ── Lazy SQL store import (only loaded when env var is present) ──────────────

let sqlStore: typeof import("./sqlSessionStore.js") | null = null;

async function getSqlStore() {
  if (!sqlStore) {
    sqlStore = await import("./sqlSessionStore.js");
  }
  return sqlStore;
}

// ── Public async API ─────────────────────────────────────────────────────────
// All callers use the async versions. For the in-memory backend these resolve
// synchronously (wrapped in Promise.resolve) so there's no overhead.

export async function createSession(): Promise<Session> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.createSession();
  }
  return Promise.resolve(memCreateSession());
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.getSession(sessionId);
  }
  return Promise.resolve(memGetSession(sessionId));
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.deleteSession(sessionId);
  }
  return Promise.resolve(memDeleteSession(sessionId));
}

export async function addMessage(
  sessionId: string,
  msg: Omit<StoredMessage, "id" | "createdAt">
): Promise<StoredMessage | null> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.addMessage(sessionId, msg);
  }
  return Promise.resolve(memAddMessage(sessionId, msg));
}

export async function updateAnalysisConfig(
  sessionId: string,
  config: AnalysisConfig
): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.updateAnalysisConfig(sessionId, config);
  }
  return Promise.resolve(memUpdateAnalysisConfig(sessionId, config));
}

export async function addGeneratedChart(
  sessionId: string,
  base64Png: string
): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.addGeneratedChart(sessionId, base64Png);
  }
  return Promise.resolve(memAddGeneratedChart(sessionId, base64Png));
}

/**
 * Update the upload on an existing session.
 * Used by both the file upload route and the DB load route.
 */
export async function setSessionUpload(
  sessionId: string,
  upload: SessionUpload | null
): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.setSessionUpload(sessionId, upload);
  }
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.upload = upload;
  return true;
}

/**
 * Persist latestAnalysis for a session.
 */
export async function setLatestAnalysis(
  sessionId: string,
  analysis: Record<string, unknown> | null
): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.setLatestAnalysis(sessionId, analysis);
  }
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.latestAnalysis = analysis;
  return true;
}

/**
 * Reset analysis state on a session (charts, config, latestAnalysis).
 * Called when new data is loaded.
 */
export async function clearSessionState(sessionId: string): Promise<boolean> {
  if (USE_SQL) {
    const store = await getSqlStore();
    return store.clearSessionState(sessionId);
  }
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.latestAnalysis = null;
  session.analysisConfig = null;
  session.generatedCharts = [];
  return true;
}
