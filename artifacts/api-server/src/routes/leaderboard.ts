import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/leaderboard", async (req, res): Promise<void> => {
  const rawLimit = req.query.limit;
  const limit = rawLimit ? Math.min(parseInt(String(rawLimit), 10) || 10, 100) : 10;

  const users = await db
    .select({
      telegramId: usersTable.telegramId,
      username: usersTable.username,
      firstName: usersTable.firstName,
      balance: usersTable.balance,
      referralCount: usersTable.referralCount,
    })
    .from(usersTable)
    .where(eq(usersTable.isBanned, false))
    .orderBy(desc(usersTable.referralCount), desc(usersTable.balance))
    .limit(limit);

  const entries = users.map((u, i) => ({
    rank: i + 1,
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.firstName,
    balance: u.balance,
    referralCount: u.referralCount,
  }));

  res.json(entries);
});

export default router;
