import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { tasksTable, userTasksTable, usersTable } from "@workspace/db";
import {
  ListTasksResponse,
  CompleteTaskParams,
  CompleteTaskBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/tasks", async (_req, res): Promise<void> => {
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.isActive, true))
    .orderBy(tasksTable.createdAt);

  res.json(ListTasksResponse.parse(tasks));
});

router.post("/tasks/:taskId/complete", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
  const taskId = parseInt(rawId ?? "", 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const params = CompleteTaskParams.safeParse({ taskId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CompleteTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId } = parsed.data;

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!task.isActive) {
    res.status(400).json({ error: "Task is no longer active" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const existing = await db
    .select()
    .from(userTasksTable)
    .where(eq(userTasksTable.telegramId, telegramId));

  const alreadyDone = existing.find((ut) => ut.taskId === taskId);
  if (alreadyDone) {
    res.status(400).json({ error: "Task already completed" });
    return;
  }

  await db.insert(userTasksTable).values({
    telegramId,
    taskId,
    rewardAmount: task.rewardAmount,
  });

  const [updated] = await db
    .update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${task.rewardAmount}` })
    .where(eq(usersTable.telegramId, telegramId))
    .returning();

  res.json(updated!);
});

export default router;
