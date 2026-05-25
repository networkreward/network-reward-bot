import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import tasksRouter from "./tasks";
import leaderboardRouter from "./leaderboard";
import adminRouter from "./admin";
import withdrawalsRouter from "./withdrawals";
import channelsRouter from "./channels";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(tasksRouter);
router.use(leaderboardRouter);
router.use(adminRouter);
router.use(withdrawalsRouter);
router.use("/admin/channels", channelsRouter);

export default router;
