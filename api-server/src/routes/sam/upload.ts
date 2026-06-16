import { Router } from "express";
import multer from "multer";
import { getSession, setSessionUpload, clearSessionState } from "../../lib/sessionStore.js";
import { parseFile } from "../../lib/dataParser.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post("/sessions/:sessionId/upload", upload.single("file"), async (req, res) => {
  const sessionId = req.params["sessionId"] as string;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No file provided. Include a file field in the multipart form." });
    return;
  }

  const fileName = req.file.originalname || "upload";
  let parsed;
  try {
    parsed = parseFile(req.file.buffer, fileName);
  } catch (err) {
    res.status(400).json({ error: `Failed to parse file: ${(err as Error).message}` });
    return;
  }

  if (parsed.rowCount === 0) {
    res.status(400).json({ error: "The file appears to be empty or could not be parsed." });
    return;
  }

  await setSessionUpload(sessionId, parsed);
  await clearSessionState(sessionId);

  const sampleRows = parsed.data.slice(0, 5);

  res.json({
    sessionId,
    fileName: parsed.fileName,
    rowCount: parsed.rowCount,
    columns: parsed.columns,
    numericColumns: parsed.numericColumns,
    sampleRows,
  });
});

export default router;
