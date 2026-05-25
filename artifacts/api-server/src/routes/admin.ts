import { Router, type IRouter } from "express";
import { eq, sql, count, sum } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, referralsTable, tasksTable, userTasksTable } from "@workspace/db";
import {
  AdminUpdateBalanceParams,
  AdminUpdateBalanceBody,
  AdminBanUserParams,
  AdminBanUserBody,
  AdminCreateTaskBody,
  AdminUpdateTaskParams,
  AdminUpdateTaskBody,
  AdminGrantBonusBody,
  AdminListUsersResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stats", async (_req, res): Promise<void> => {
  const [userCount] = await db.select({ count: count() }).from(usersTable);
  const [referralCount] = await db.select({ count: count() }).from(referralsTable);
  const [pointsSum] = await db.select({ total: sum(usersTable.balance) }).from(usersTable);
  const [activeTaskCount] = await db
    .select({ count: count() })
    .from(tasksTable)
    .where(eq(tasksTable.isActive, true));

  res.json({
    totalUsers: userCount?.count ?? 0,
    totalReferrals: referralCount?.count ?? 0,
    totalPointsDistributed: Number(pointsSum?.total ?? 0),
    activeTasks: activeTaskCount?.count ?? 0,
  });
});

router.get("/admin/users", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

  const users = await db
    .select()
    .from(usersTable)
    .orderBy(usersTable.createdAt)
    .limit(limit)
    .offset(offset);

  res.json(AdminListUsersResponse.parse(users));
});

router.patch("/admin/users/:telegramId/balance", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId;
  const params = AdminUpdateBalanceParams.safeParse({ telegramId: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AdminUpdateBalanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${parsed.data.amount}` })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  res.json(updated!);
});

router.patch("/admin/users/:telegramId/ban", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId;
  const params = AdminBanUserParams.safeParse({ telegramId: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AdminBanUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ isBanned: parsed.data.banned })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  res.json(updated!);
});

router.post("/admin/tasks", async (req, res): Promise<void> => {
  const parsed = AdminCreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [task] = await db.insert(tasksTable).values({
    title: parsed.data.title,
    description: parsed.data.description,
    rewardAmount: parsed.data.rewardAmount,
    isActive: parsed.data.isActive ?? true,
  }).returning();

  res.status(201).json(task!);
});

router.patch("/admin/tasks/:taskId", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
  const taskId = parseInt(rawId ?? "", 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const params = AdminUpdateTaskParams.safeParse({ taskId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AdminUpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const updates: Partial<typeof tasksTable.$inferInsert> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.rewardAmount !== undefined) updates.rewardAmount = parsed.data.rewardAmount;
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;

  const [updated] = await db
    .update(tasksTable)
    .set(updates)
    .where(eq(tasksTable.id, taskId))
    .returning();

  res.json(updated!);
});

router.delete("/admin/tasks/:taskId", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
  const taskId = parseInt(rawId ?? "", 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  await db.delete(tasksTable).where(eq(tasksTable.id, taskId));
  res.sendStatus(204);
});

router.post("/admin/bonus", async (req, res): Promise<void> => {
  const parsed = AdminGrantBonusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, parsed.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${parsed.data.amount}` })
    .where(eq(usersTable.telegramId, parsed.data.telegramId))
    .returning();

  res.json(updated!);
});

export default router;
