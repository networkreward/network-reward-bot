import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import tasksRouter from "./tasks";
import leaderboardRouter from "./leaderboard";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(tasksRouter);
router.use(leaderboardRouter);
router.use(adminRouter);

export default router;
