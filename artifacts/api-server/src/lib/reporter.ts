import { Telegraf } from "telegraf";
import { eq, sql, and, gt, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, referralsTable, withdrawalsTable, botSettingsTable } from "@workspace/db";
import { logger } from "./logger";

// ─── Constants ─────────────────────────────────────────────────────────────────
const REFERRAL_REWARD = 800;
const DAILY_REPORT_HOUR_UTC = 8;
const WEEKLY_REPORT_DAY_UTC = 1; // Monday
const DEFAULT_LARGE_THRESHOLD = 25_000;

const RKEYS = {
  LAST_DAILY: "report_last_daily",
  LAST_WEEKLY: "report_last_weekly",
  DAILY_HOUR: "report_daily_hour",
  LARGE_THRESHOLD: "report_large_threshold",
} as const;

// ─── Formatting helpers ─────────────────────────────────────────────────────────
function bar(value: number, max: number, width = 12): string {
  if (max <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function delta(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return "→ stable";
  const pct = previous > 0 ? ` (${diff > 0 ? "+" : ""}${Math.round((diff / previous) * 100)}%)` : "";
  return diff > 0 ? `▲ +${diff}${pct}` : `▼ ${diff}${pct}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("fr-FR");
}

function todayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function weekStart(): Date {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function prevWeekStart(): Date {
  const d = weekStart();
  d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────────
async function getRkey(key: string, def: string): Promise<string> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key));
  return row?.value ?? def;
}

async function setRkey(key: string, value: string): Promise<void> {
  await db.insert(botSettingsTable).values({ key, value, updatedBy: "system" }).onConflictDoUpdate({
    target: botSettingsTable.key,
    set: { value, updatedAt: new Date() },
  });
}

async function sendToAdmins(telegram: Telegraf["telegram"], adminIdList: string[], message: string): Promise<void> {
  for (const adminId of adminIdList) {
    try {
      await telegram.sendMessage(adminId, message, { parse_mode: "HTML" });
    } catch (err) {
      logger.warn({ err, adminId }, "Impossible d'envoyer à l'admin");
    }
  }
}

// ─── Daily Report ───────────────────────────────────────────────────────────────
export async function generateDailyReport(): Promise<string> {
  const start = todayStart();
  const yesterday = new Date(start.getTime() - 24 * 3_600_000);

  const [
    [r_newUsers],
    [r_prevUsers],
    [r_newRefs],
    [r_prevRefs],
    [r_approvedCnt],
    [r_approvedAmt],
    [r_rejectedCnt],
    [r_pendingCnt],
    [r_pendingAmt],
    [r_fraudToday],
    [r_totalUsers],
    [r_totalBal],
    topUsers,
  ] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable)
      .where(gt(usersTable.createdAt, start)),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable)
      .where(and(gt(usersTable.createdAt, yesterday), sql`${usersTable.createdAt} < ${start}`)),
    db.select({ v: sql<number>`count(*)::int` }).from(referralsTable)
      .where(gt(referralsTable.createdAt, start)),
    db.select({ v: sql<number>`count(*)::int` }).from(referralsTable)
      .where(and(gt(referralsTable.createdAt, yesterday), sql`${referralsTable.createdAt} < ${start}`)),
    db.select({ v: sql<number>`count(*)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "approved"), gt(withdrawalsTable.processedAt, start))),
    db.select({ v: sql<number>`coalesce(sum(amount),0)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "approved"), gt(withdrawalsTable.processedAt, start))),
    db.select({ v: sql<number>`count(*)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "rejected"), gt(withdrawalsTable.processedAt, start))),
    db.select({ v: sql<number>`count(*)::int` }).from(withdrawalsTable)
      .where(eq(withdrawalsTable.status, "pending")),
    db.select({ v: sql<number>`coalesce(sum(amount),0)::int` }).from(withdrawalsTable)
      .where(eq(withdrawalsTable.status, "pending")),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable)
      .where(and(eq(usersTable.flaggedForFraud, true), gt(usersTable.updatedAt, start))),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable),
    db.select({ v: sql<number>`coalesce(sum(balance),0)::int` }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false))),
    db.select().from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
      .orderBy(desc(usersTable.balance)).limit(5),
  ]);

  const newUsers = r_newUsers?.v ?? 0;
  const prevUsers = r_prevUsers?.v ?? 0;
  const newRefs   = r_newRefs?.v ?? 0;
  const prevRefs  = r_prevRefs?.v ?? 0;
  const approvedCnt = r_approvedCnt?.v ?? 0;
  const approvedAmt = r_approvedAmt?.v ?? 0;
  const rejectedCnt = r_rejectedCnt?.v ?? 0;
  const pendingCnt  = r_pendingCnt?.v ?? 0;
  const pendingAmt  = r_pendingAmt?.v ?? 0;
  const fraudToday  = r_fraudToday?.v ?? 0;
  const totalUsers  = r_totalUsers?.v ?? 0;
  const totalBal    = r_totalBal?.v ?? 0;
  const rewardsToday = newRefs * REFERRAL_REWARD;

  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time  = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  const topLines = topUsers.map((u, i) => {
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
    return `${medals[i]!} ${name}  ·  <b>${fmtNum(u.balance)} F</b>  ·  👥 ${u.referralCount}`;
  }).join("\n");

  const fraudLine = fraudToday > 0
    ? `🚨 <b>${fraudToday} compte(s) suspect(s)</b> — /admin_fraude`
    : `✅ Aucune activité suspecte`;

  const pendingAlert = pendingCnt > 5
    ? `\n⚠️ <b>Attention :</b> ${pendingCnt} retraits en attente — /admin_retraits`
    : "";

  return (
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `   📊  <b>RAPPORT QUOTIDIEN</b>\n` +
    `   📅 ${today}\n` +
    `   🕗 Généré à ${time} UTC\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `👥 <b>UTILISATEURS</b>\n` +
    `──────────────────────\n` +
    `📌 Communauté totale : <b>${fmtNum(totalUsers)}</b>\n` +
    `🆕 Nouveaux aujourd'hui : <b>+${newUsers}</b>\n` +
    `${bar(newUsers, Math.max(newUsers, prevUsers, 1))}  <i>${delta(newUsers, prevUsers)}</i>\n\n` +

    `🔗 <b>PARRAINAGES</b>\n` +
    `──────────────────────\n` +
    `📨 Nouveaux : <b>+${newRefs}</b>  <i>${delta(newRefs, prevRefs)}</i>\n` +
    `${bar(newRefs, Math.max(newRefs, prevRefs, 1))}  vs hier\n` +
    `💰 Récompenses : <b>${fmtNum(rewardsToday)} F</b>\n\n` +

    `💸 <b>RETRAITS</b>\n` +
    `──────────────────────\n` +
    `⏳ En attente : <b>${pendingCnt}</b>  (${fmtNum(pendingAmt)} F)${pendingAlert}\n` +
    `✅ Approuvés : <b>${approvedCnt}</b>  →  <b>${fmtNum(approvedAmt)} F</b>\n` +
    `❌ Refusés : <b>${rejectedCnt}</b>\n\n` +

    `🛡️ <b>SÉCURITÉ</b>\n` +
    `──────────────────────\n` +
    `${fraudLine}\n\n` +

    `🏆 <b>TOP 5 SOLDES</b>\n` +
    `──────────────────────\n` +
    `${topLines || "Aucune donnée"}\n\n` +

    `💵 <b>Fonds communauté :</b>  <b>${fmtNum(totalBal)} F</b>\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦  <b>NETWORK COMMUNITY</b>  ·  Rapport Auto\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ─── Weekly Report ──────────────────────────────────────────────────────────────
export async function generateWeeklyReport(): Promise<string> {
  const wStart  = weekStart();
  const pwStart = prevWeekStart();

  const [
    [r_newW], [r_newPW],
    [r_refsW], [r_refsPW],
    [r_appCntW], [r_appAmtW],
    [r_rejW],
    [r_totalUsers],
    [r_bannedUsers],
    [r_fraudUsers],
    [r_totalBal],
    topRef, topBal,
  ] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable)
      .where(gt(usersTable.createdAt, wStart)),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable)
      .where(and(gt(usersTable.createdAt, pwStart), sql`${usersTable.createdAt} < ${wStart}`)),
    db.select({ v: sql<number>`count(*)::int` }).from(referralsTable)
      .where(gt(referralsTable.createdAt, wStart)),
    db.select({ v: sql<number>`count(*)::int` }).from(referralsTable)
      .where(and(gt(referralsTable.createdAt, pwStart), sql`${referralsTable.createdAt} < ${wStart}`)),
    db.select({ v: sql<number>`count(*)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "approved"), gt(withdrawalsTable.processedAt, wStart))),
    db.select({ v: sql<number>`coalesce(sum(amount),0)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "approved"), gt(withdrawalsTable.processedAt, wStart))),
    db.select({ v: sql<number>`count(*)::int` }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "rejected"), gt(withdrawalsTable.processedAt, wStart))),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.isBanned, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.flaggedForFraud, true)),
    db.select({ v: sql<number>`coalesce(sum(balance),0)::int` }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false))),
    db.select().from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
      .orderBy(desc(usersTable.referralCount)).limit(5),
    db.select().from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
      .orderBy(desc(usersTable.balance)).limit(3),
  ]);

  const newW  = r_newW?.v  ?? 0;
  const newPW = r_newPW?.v ?? 0;
  const refsW  = r_refsW?.v  ?? 0;
  const refsPW = r_refsPW?.v ?? 0;
  const appCntW = r_appCntW?.v ?? 0;
  const appAmtW = r_appAmtW?.v ?? 0;
  const rejW    = r_rejW?.v ?? 0;
  const totalUsers  = r_totalUsers?.v  ?? 0;
  const bannedUsers = r_bannedUsers?.v ?? 0;
  const fraudUsers  = r_fraudUsers?.v  ?? 0;
  const totalBal    = r_totalBal?.v    ?? 0;
  const rewardsW = refsW * REFERRAL_REWARD;

  const growthPct = newPW > 0 ? Math.round(((newW - newPW) / newPW) * 100) : (newW > 0 ? 100 : 0);
  const growthIcon = growthPct > 0 ? "📈" : growthPct < 0 ? "📉" : "➡️";

  const weekLabel = wStart.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  const today     = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  const healthScore = Math.max(0, Math.min(100, 100 - (fraudUsers + bannedUsers) * 5));
  const healthBar   = bar(healthScore, 100, 14);
  const healthLabel = healthScore >= 90 ? "🟢 Excellent" : healthScore >= 70 ? "🟡 Bon" : "🔴 À surveiller";

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  const topRefLines = topRef.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
    return `${medals[i]!} ${name}  ·  <b>${u.referralCount}</b> filleuls  ·  ${fmtNum(u.balance)} F`;
  }).join("\n");

  const topBalLines = topBal.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
    return `${medals[i]!} ${name}  ·  <b>${fmtNum(u.balance)} F</b>`;
  }).join("\n");

  const maxBar = Math.max(newW, newPW, 1);

  return (
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `   📈  <b>RAPPORT HEBDOMADAIRE</b>\n` +
    `   📅 Semaine du ${weekLabel}\n` +
    `   🗓️ Généré le ${today}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `👥 <b>CROISSANCE DE LA COMMUNAUTÉ</b>\n` +
    `────────────────────────────────\n` +
    `📌 Total membres : <b>${fmtNum(totalUsers)}</b>\n` +
    `🆕 Cette semaine : <b>+${newW}</b>  ${growthIcon} <b>${growthPct >= 0 ? "+" : ""}${growthPct}%</b>\n` +
    `Cette sem. : ${bar(newW, maxBar, 14)}  ${newW}\n` +
    `Sem. passée: ${bar(newPW, maxBar, 14)}  ${newPW}\n\n` +

    `🔗 <b>PARRAINAGES</b>\n` +
    `────────────────────────────────\n` +
    `📨 Cette semaine : <b>+${refsW}</b>  <i>${delta(refsW, refsPW)}</i>\n` +
    `💰 Récompenses générées : <b>${fmtNum(rewardsW)} F</b>\n\n` +

    `🏆 <b>TOP PARRAINS DE LA SEMAINE</b>\n` +
    `────────────────────────────────\n` +
    `${topRefLines || "Aucune donnée"}\n\n` +

    `💸 <b>RETRAITS DE LA SEMAINE</b>\n` +
    `────────────────────────────────\n` +
    `✅ Approuvés : <b>${appCntW}</b>  →  <b>${fmtNum(appAmtW)} F</b>\n` +
    `❌ Refusés : <b>${rejW}</b>\n\n` +

    `💰 <b>TOP 3 SOLDES</b>\n` +
    `────────────────────────────────\n` +
    `${topBalLines || "Aucune donnée"}\n\n` +

    `💵 <b>Fonds communauté :</b>  <b>${fmtNum(totalBal)} F</b>\n\n` +

    `🛡️ <b>SANTÉ DE LA COMMUNAUTÉ</b>\n` +
    `────────────────────────────────\n` +
    `${healthBar}  ${healthScore}/100  ${healthLabel}\n` +
    `🚫 Bannis : <b>${bannedUsers}</b>  ·  ⚠️ Fraudes : <b>${fraudUsers}</b>\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦  <b>NETWORK COMMUNITY</b>  ·  Rapport Hebdo\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ─── Scheduler ──────────────────────────────────────────────────────────────────
export async function checkAndSendScheduledReports(
  telegram: Telegraf["telegram"],
  adminIdList: string[]
): Promise<void> {
  if (adminIdList.length === 0) return;
  const now     = new Date();
  const hourUTC = now.getUTCHours();
  const dayUTC  = now.getUTCDay();

  const targetHour = parseInt(await getRkey(RKEYS.DAILY_HOUR, String(DAILY_REPORT_HOUR_UTC)), 10);

  // Daily report
  if (hourUTC === targetHour) {
    const lastTs = parseInt(await getRkey(RKEYS.LAST_DAILY, "0"), 10);
    if ((now.getTime() - lastTs) >= 23 * 3_600_000) {
      logger.info("Envoi rapport quotidien automatique");
      await setRkey(RKEYS.LAST_DAILY, String(now.getTime()));
      const report = await generateDailyReport();
      await sendToAdmins(telegram, adminIdList, report);
    }
  }

  // Weekly report (Monday at target hour)
  if (dayUTC === WEEKLY_REPORT_DAY_UTC && hourUTC === targetHour) {
    const lastTs = parseInt(await getRkey(RKEYS.LAST_WEEKLY, "0"), 10);
    if ((now.getTime() - lastTs) >= 6 * 24 * 3_600_000) {
      logger.info("Envoi rapport hebdomadaire automatique");
      await setRkey(RKEYS.LAST_WEEKLY, String(now.getTime()));
      const report = await generateWeeklyReport();
      await sendToAdmins(telegram, adminIdList, report);
    }
  }
}

// ─── Alerts ─────────────────────────────────────────────────────────────────────
export async function sendLargeWithdrawalAlert(
  telegram: Telegraf["telegram"],
  adminIdList: string[],
  withdrawal: { id: number; amount: number; paymentMethod: string; telegramId: string },
  displayName: string
): Promise<void> {
  const threshold = parseInt(await getRkey(RKEYS.LARGE_THRESHOLD, String(DEFAULT_LARGE_THRESHOLD)), 10);
  if (withdrawal.amount < threshold) return;

  const msg =
    `🚨 <b>ALERTE — RETRAIT ÉLEVÉ</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 Référence : <code>#${String(withdrawal.id).padStart(5, "0")}</code>\n` +
    `👤 Utilisateur : ${displayName}  (<code>${withdrawal.telegramId}</code>)\n` +
    `💵 Montant : <b>${withdrawal.amount.toLocaleString("fr-FR")} F</b>  ⚠️ <i>seuil ${threshold.toLocaleString("fr-FR")} F</i>\n` +
    `💳 Méthode : ${withdrawal.paymentMethod}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ /admin_approuver_${withdrawal.id}\n` +
    `❌ /admin_rejeter_${withdrawal.id} <raison>\n` +
    `🔍 /admin_user ${withdrawal.telegramId}`;

  await sendToAdmins(telegram, adminIdList, msg);
}

export async function sendFraudAlert(
  telegram: Telegraf["telegram"],
  adminIdList: string[],
  user: { telegramId: string; username?: string | null; firstName?: string | null; referralCount: number }
): Promise<void> {
  const name = user.username ? `@${user.username}` : (user.firstName ?? "Inconnu");
  const msg =
    `🚨 <b>ALERTE FRAUDE AUTOMATIQUE</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 Compte : ${name}  (<code>${user.telegramId}</code>)\n` +
    `👥 Parrainages suspects : <b>${user.referralCount}</b>\n` +
    `📋 Raison : <i>Taux de parrainage anormal détecté</i>\n` +
    `⏰ Détecté : ${new Date().toLocaleString("fr-FR")}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔍 /admin_user ${user.telegramId}\n` +
    `🔨 /admin_ban ${user.telegramId}`;

  await sendToAdmins(telegram, adminIdList, msg);
}

export async function getReportConfig(): Promise<{
  dailyHour: number;
  largeThreshold: number;
  lastDaily: Date | null;
  lastWeekly: Date | null;
}> {
  const [dailyHourStr, thresholdStr, lastDailyStr, lastWeeklyStr] = await Promise.all([
    getRkey(RKEYS.DAILY_HOUR, String(DAILY_REPORT_HOUR_UTC)),
    getRkey(RKEYS.LARGE_THRESHOLD, String(DEFAULT_LARGE_THRESHOLD)),
    getRkey(RKEYS.LAST_DAILY, "0"),
    getRkey(RKEYS.LAST_WEEKLY, "0"),
  ]);
  const lastDailyTs  = parseInt(lastDailyStr, 10);
  const lastWeeklyTs = parseInt(lastWeeklyStr, 10);
  return {
    dailyHour: parseInt(dailyHourStr, 10),
    largeThreshold: parseInt(thresholdStr, 10),
    lastDaily:  lastDailyTs  > 0 ? new Date(lastDailyTs)  : null,
    lastWeekly: lastWeeklyTs > 0 ? new Date(lastWeeklyTs) : null,
  };
}

export async function setReportDailyHour(hour: number): Promise<void> {
  await setRkey(RKEYS.DAILY_HOUR, String(hour));
}

export async function setReportLargeThreshold(amount: number): Promise<void> {
  await setRkey(RKEYS.LARGE_THRESHOLD, String(amount));
}
