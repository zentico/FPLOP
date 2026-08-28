import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectionsRouter from "./projections";
import fplRouter from "./fpl";
import solvesRouter from "./solves";
import accuracyRouter from "./accuracy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectionsRouter);
router.use(fplRouter);
router.use(solvesRouter);
router.use(accuracyRouter);

export default router;
