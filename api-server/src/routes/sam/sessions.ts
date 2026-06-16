import { Router } from "express";
import {
  createSession,
  getSession,
  deleteSession,
} from "../../lib/sessionStore.js";

const router = Router();

router.post("/sessions", async (_req, res) => {
  const session = await createSession();
  res.status(201).json({
    sessionId: session.sessionId,
    createdAt: session.createdAt.toISOString(),
  });
});

router.get("/sessions/:sessionId", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    sessionId: session.sessionId,
    createdAt: session.createdAt.toISOString(),
    upload: session.upload
      ? {
          fileName: session.upload.fileName,
          rowCount: session.upload.rowCount,
          columns: session.upload.columns,
          numericColumns: session.upload.numericColumns,
        }
      : undefined,
    latestAnalysis: session.latestAnalysis ?? undefined,
    messageCount: session.messages.length,
  });
});

router.delete("/sessions/:sessionId", async (req, res) => {
  const existed = await deleteSession(req.params.sessionId);
  if (!existed) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.status(204).send();
});

export default router;
