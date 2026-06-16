import { Router } from "express";
import sessionsRouter from "./sessions.js";
import uploadRouter from "./upload.js";
import messagesRouter from "./messages.js";
import chatRouter from "./chat.js";
import dbConnectRouter from "./dbConnect.js";

const router = Router();

router.use(sessionsRouter);
router.use(uploadRouter);
router.use(messagesRouter);
router.use(chatRouter);
router.use(dbConnectRouter);

export default router;
