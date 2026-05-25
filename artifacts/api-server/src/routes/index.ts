import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import tasksRouter from "./tasks";
import leaderboardRouter from "./leaderboard";
import adminRouter from "./admin";
import withdrawalsRouter from "./withdrawals";
import channelsRouter from "./channels";
import broadcastsRouter from "./broadcasts";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(tasksRouter);
router.use(leaderboardRouter);
router.use(adminRouter);
router.use(withdrawalsRouter);
router.use("/admin/channels", channelsRouter);
router.use("/admin/broadcasts", broadcastsRouter);
router.use("/admin/settings", settingsRouter);

export default router;
