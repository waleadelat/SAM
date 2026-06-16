import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import samRouter from "./sam/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/sam", samRouter);

export default router;
