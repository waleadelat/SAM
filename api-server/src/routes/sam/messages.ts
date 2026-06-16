import { Router } from "express";
import { getSession } from "../../lib/sessionStore.js";

const router = Router();

router.get("/sessions/:sessionId/messages", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(
    session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      analysis: m.analysis ?? undefined,
      createdAt: m.createdAt.toISOString(),
    }))
  );
});

export default router;
