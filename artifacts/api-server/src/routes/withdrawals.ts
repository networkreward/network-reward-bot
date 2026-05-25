import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withdrawalsTable, usersTable } from "@workspace/db";
import {
  GetUserWithdrawalsParams,
  RequestWithdrawalBody,
  AdminListWithdrawalsQueryParams,
  AdminProcessWithdrawalParams,
  AdminProcessWithdrawalBody,
} from "@workspace/api-zod";

const MIN_WITHDRAWAL = 10_000;

const router: IRouter = Router();

router.get("/users/:telegramId/withdrawals", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId;
  const params = GetUserWithdrawalsParams.safeParse({ telegramId: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, params.data.telegramId));
  if (!user) {
    res.status(404).json({ error: "Utilisateur introuvable" });
    return;
  }

  const history = await db.select().from(withdrawalsTable)
    .where(eq(withdrawalsTable.telegramId, params.data.telegramId))
    .orderBy(desc(withdrawalsTable.requestedAt));

  res.json(history);
});

router.post("/withdrawals", async (req, res): Promise<void> => {
  const parsed = RequestWithdrawalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, amount, paymentMethod, paymentDetails } = parsed.data;

  if (amount < MIN_WITHDRAWAL) {
    res.status(400).json({ error: `Le montant minimum de retrait est de ${MIN_WITHDRAWAL} F` });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
  if (!user) {
    res.status(404).json({ error: "Utilisateur introuvable" });
    return;
  }

  if (user.balance < amount) {
    res.status(400).json({ error: "Solde insuffisant" });
    return;
  }

  const pending = await db.select().from(withdrawalsTable)
    .where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
  if (pending.length > 0) {
    res.status(400).json({ error: "Un retrait est déjà en attente" });
    return;
  }

  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} - ${amount}` })
    .where(eq(usersTable.telegramId, telegramId));

  const [withdrawal] = await db.insert(withdrawalsTable).values({
    telegramId,
    amount,
    paymentMethod,
    paymentDetails,
    status: "pending",
  }).returning();

  res.status(201).json(withdrawal!);
});

router.get("/admin/withdrawals", async (req, res): Promise<void> => {
  const query = AdminListWithdrawalsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = query.data.status
    ? [eq(withdrawalsTable.status, query.data.status)]
    : [];

  const withdrawals = await db
    .select({
      id: withdrawalsTable.id,
      telegramId: withdrawalsTable.telegramId,
      username: usersTable.username,
      firstName: usersTable.firstName,
      amount: withdrawalsTable.amount,
      status: withdrawalsTable.status,
      paymentMethod: withdrawalsTable.paymentMethod,
      paymentDetails: withdrawalsTable.paymentDetails,
      adminNote: withdrawalsTable.adminNote,
      requestedAt: withdrawalsTable.requestedAt,
      processedAt: withdrawalsTable.processedAt,
    })
    .from(withdrawalsTable)
    .leftJoin(usersTable, eq(withdrawalsTable.telegramId, usersTable.telegramId))
    .where(conditions.length ? conditions[0] : undefined)
    .orderBy(desc(withdrawalsTable.requestedAt));

  res.json(withdrawals);
});

router.patch("/admin/withdrawals/:withdrawalId", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.withdrawalId) ? req.params.withdrawalId[0] : req.params.withdrawalId;
  const wId = parseInt(rawId ?? "", 10);
  if (isNaN(wId)) {
    res.status(400).json({ error: "ID invalide" });
    return;
  }

  const params = AdminProcessWithdrawalParams.safeParse({ withdrawalId: wId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AdminProcessWithdrawalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [withdrawal] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, wId));
  if (!withdrawal) {
    res.status(404).json({ error: "Retrait introuvable" });
    return;
  }

  if (withdrawal.status !== "pending") {
    res.status(400).json({ error: `Ce retrait est déjà ${withdrawal.status}` });
    return;
  }

  const [updated] = await db.update(withdrawalsTable)
    .set({
      status: parsed.data.action,
      processedAt: new Date(),
      adminNote: parsed.data.adminNote ?? null,
    })
    .where(eq(withdrawalsTable.id, wId))
    .returning();

  if (parsed.data.action === "rejected") {
    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${withdrawal.amount}` })
      .where(eq(usersTable.telegramId, withdrawal.telegramId));
  }

  res.json(updated!);
});

export default router;
