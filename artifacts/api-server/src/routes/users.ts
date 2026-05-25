import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, referralsTable, tasksTable, userTasksTable } from "@workspace/db";
import {
  RegisterUserBody,
  GetUserParams,
  GetUserReferralsParams,
  GetUserTasksParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/register", async (req, res): Promise<void> => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, username, firstName, lastName, referredByTelegramId } = parsed.data;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (existing.length > 0) {
    const user = existing[0]!;
    await db
      .update(usersTable)
      .set({ username: username ?? user.username, firstName: firstName ?? user.firstName, lastName: lastName ?? user.lastName })
      .where(eq(usersTable.telegramId, telegramId));
    const updated = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    res.json(updated[0]!);
    return;
  }

  const REFERRAL_REWARD = 50;

  const [newUser] = await db.insert(usersTable).values({
    telegramId,
    username,
    firstName,
    lastName,
    referredByTelegramId,
    balance: 0,
    referralCount: 0,
  }).returning();

  if (referredByTelegramId) {
    const [referrer] = await db.select().from(usersTable).where(eq(usersTable.telegramId, referredByTelegramId));
    if (referrer && !referrer.isBanned) {
      await db.insert(referralsTable).values({
        referrerId: referredByTelegramId,
        referredId: telegramId,
        rewardAmount: REFERRAL_REWARD,
      }).onConflictDoNothing();

      await db.update(usersTable)
        .set({
          balance: sql`${usersTable.balance} + ${REFERRAL_REWARD}`,
          referralCount: sql`${usersTable.referralCount} + 1`,
        })
        .where(eq(usersTable.telegramId, referredByTelegramId));
    }
  }

  res.json(newUser!);
});

router.get("/users/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

router.get("/users/:telegramId/referrals", async (req, res): Promise<void> => {
  const params = GetUserReferralsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const referrals = await db
    .select({
      id: referralsTable.id,
      referrerId: referralsTable.referrerId,
      referredId: referralsTable.referredId,
      referredUsername: usersTable.username,
      rewardAmount: referralsTable.rewardAmount,
      createdAt: referralsTable.createdAt,
    })
    .from(referralsTable)
    .leftJoin(usersTable, eq(referralsTable.referredId, usersTable.telegramId))
    .where(eq(referralsTable.referrerId, params.data.telegramId))
    .orderBy(desc(referralsTable.createdAt));

  res.json(referrals);
});

router.get("/users/:telegramId/tasks", async (req, res): Promise<void> => {
  const params = GetUserTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const completions = await db
    .select({
      id: userTasksTable.id,
      taskId: userTasksTable.taskId,
      taskTitle: tasksTable.title,
      rewardAmount: userTasksTable.rewardAmount,
      completedAt: userTasksTable.completedAt,
    })
    .from(userTasksTable)
    .innerJoin(tasksTable, eq(userTasksTable.taskId, tasksTable.id))
    .where(eq(userTasksTable.telegramId, params.data.telegramId))
    .orderBy(desc(userTasksTable.completedAt));

  res.json(completions);
});

export default router;
