 import {import{ Telegraf, Markup } from "telegraf";
import { eq, sql, desc, and, gt, lt, count } from "drizzle-orm";
import { db } from "@workspace/db";
  usersTable,
  referralsTable,
  tasksTable,
  userTasksTable,
  withdrawalsTable,
  requiredChannelsTable,
  broadcastsTable,
  botSettingsTable,
  SETTING_KEYS,
  type RequiredChannel,
} from "@workspace/db";
import { logger } from "./logger";
import {
  checkAndSendScheduledReports,
  sendLargeWithdrawalAlert,
  sendFraudAlert,
  generateDailyReport,
  generateWeeklyReport,
  getReportConfig,
  setReportDailyHour,
  setReportLargeThreshold,
} from "./reporter";

// ─── Constants ────────────────────────────────────────────────────────────────
const REFERRAL_REWARD = 800;
const DAILY_BONUS = 200;
const WELCOME_BONUS = 500;
const MIN_WITHDRAWAL = 10_000;
const MIN_TASKS_FOR_BONUS = 1;
const DAILY_BONUS_HOURS = 24;
const FRAUD_REFERRAL_WINDOW_MS = 5 * 60 * 1000;
const FRAUD_REFERRAL_MAX = 5;
const BROADCAST_DELAY_MS = 50;
const ACTIVE_USER_DAYS = 30;
const WITHDRAWAL_PROOF_CHANNEL_KEY = "withdrawal_proof_channel";
const DEFAULT_PROOF_CHANNEL = "@NetworkRetrait";

// ─── Settings cache ───────────────────────────────────────────────────────────
interface SettingsCache {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  welcomeMessage: string | null;
  withdrawalProofChannel: string;
  refreshedAt: number;
}
let settingsCache: SettingsCache = {
  maintenanceMode: false,
  maintenanceMessage: "🔧 Le bot est en maintenance. Revenez bientôt !",
  welcomeMessage: null,
  withdrawalProofChannel: DEFAULT_PROOF_CHANNEL,
  refreshedAt: 0,
};
const CACHE_TTL_MS = 30_000;

async function refreshSettingsCache(): Promise<void> {
  const settings = await db.select().from(botSettingsTable);
  const map = new Map(settings.map((s) => [s.key, s.value]));
  settingsCache = {
    maintenanceMode: map.get(SETTING_KEYS.MAINTENANCE_MODE) === "true",
    maintenanceMessage: map.get(SETTING_KEYS.MAINTENANCE_MESSAGE) ?? "🔧 Le bot est en maintenance. Revenez bientôt !",
    welcomeMessage: map.get(SETTING_KEYS.WELCOME_MESSAGE) ?? null,
    withdrawalProofChannel: map.get(WITHDRAWAL_PROOF_CHANNEL_KEY) ?? DEFAULT_PROOF_CHANNEL,
    refreshedAt: Date.now(),
  };
}

async function getSettings(): Promise<SettingsCache> {
  if (Date.now() - settingsCache.refreshedAt > CACHE_TTL_MS) await refreshSettingsCache();
  return settingsCache;
}

// ─── Conversation state ───────────────────────────────────────────────────────
type ConvStep = "awaiting_amount" | "awaiting_method" | "awaiting_details";
interface ConvState { step: ConvStep; amount?: number; method?: string; }
const convState = new Map<string, ConvState>();

type BroadcastStep = "type" | "content" | "target" | "schedule_choice" | "schedule_time" | "confirm";
interface BroadcastState {
  step: BroadcastStep;
  msgType?: "text" | "photo" | "video";
  content?: string;
  mediaFileId?: string;
  target?: "all" | "active";
  scheduledAt?: Date;
}
const broadcastState = new Map<string, BroadcastState>();

type AdminSettingStep = "welcome_content" | "maintenance_message";
interface AdminSettingState { step: AdminSettingStep; }
const adminSettingState = new Map<string, AdminSettingState>();

type AdminUserStep = "au_add_amount" | "au_rem_amount" | "au_bonus_amount" | "au_dm_content";
interface AdminUserState { step: AdminUserStep; targetId: string; }
const adminUserState = new Map<string, AdminUserState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function adminIds(): string[] {
  return (process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function getActiveChannels(): Promise<RequiredChannel[]> {
  const fromDb = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.isActive, true));
  if (fromDb.length > 0) return fromDb;
  const envChannel = process.env["REQUIRED_CHANNEL"];
  if (envChannel) return [{ id: 0, channelId: envChannel, channelName: envChannel, addedBy: "env", isActive: true, createdAt: new Date() }];
  return [];
}

async function getMissingChannels(telegram: Telegraf["telegram"], userId: string): Promise<RequiredChannel[]> {
  const channels = await getActiveChannels();
  if (channels.length === 0) return [];
  const missing: RequiredChannel[] = [];
  for (const ch of channels) {
    try {
      const member = await telegram.getChatMember(ch.channelId, parseInt(userId, 10));
      if (!["member", "administrator", "creator", "restricted"].includes(member.status)) missing.push(ch);
    } catch { missing.push(ch); }
  }
  return missing;
}

async function requireChannels(ctx: any): Promise<boolean> {
  const channels = await getActiveChannels();
  if (channels.length === 0) return true;
  const telegramId = String(ctx.from?.id ?? "");
  const missing = await getMissingChannels(ctx.telegram, telegramId);
  if (missing.length === 0) return true;
  const channelList = missing.map((ch) => `• ${ch.channelName}`).join("\n");
  await ctx.reply(
    `🔒 <b>Accès requis</b>\n\nRejoignez ${missing.length === 1 ? "ce canal" : "ces canaux"} pour utiliser le bot :\n\n${channelList}\n\nCliquez sur chaque bouton puis vérifiez.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...missing.map((ch) => [Markup.button.url(`📢 ${ch.channelName}`, `https://t.me/${ch.channelId.replace("@", "")}`)]),
        [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
      ]),
    }
  );
  return false;
}

async function getOrFailUser(ctx: any, telegramId: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
  if (!user) { await ctx.reply("❌ Compte introuvable. Tapez /start pour vous inscrire."); return null; }
  if (user.isBanned) { await ctx.reply("🚫 Votre compte a été suspendu. Contactez l'administrateur."); return null; }
  return user;
}

async function detectFraud(referrerId: string, referredCreatedAt: Date): Promise<boolean> {
  const windowStart = new Date(Date.now() - FRAUD_REFERRAL_WINDOW_MS);
  const [recent] = await db.select({ c: count() }).from(referralsTable)
    .where(and(eq(referralsTable.referrerId, referrerId), gt(referralsTable.createdAt, windowStart)));
  if ((recent?.c ?? 0) >= FRAUD_REFERRAL_MAX) return true;
  const [referrer] = await db.select().from(usersTable).where(eq(usersTable.telegramId, referrerId));
  if (referrer && Math.abs(referredCreatedAt.getTime() - referrer.createdAt.getTime()) < 30_000) return true;
  return false;
}

function mainMenu() {
  return Markup.keyboard([
    ["💰 Mon Solde", "🔗 Mon Lien de Parrainage"],
    ["📋 Mes Tâches", "🏆 Classement"],
    ["🎁 Bonus Quotidien", "💸 Retrait"],
    ["ℹ️ Aide"],
  ]).resize();
}

async function isAdmin(ctx: any): Promise<boolean> {
  if (!adminIds().includes(String(ctx.from?.id ?? ""))) {
    await ctx.reply("❌ Commande réservée aux administrateurs.");
    return false;
  }
  return true;
}

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key));
  return row?.value ?? null;
}

async function setSetting(key: string, value: string, updatedBy: string): Promise<void> {
  await db.insert(botSettingsTable).values({ key, value, updatedBy }).onConflictDoUpdate({
    target: botSettingsTable.key,
    set: { value, updatedBy, updatedAt: new Date() },
  });
  settingsCache.refreshedAt = 0;
}

async function getBotUsername(telegram: Telegraf["telegram"]): Promise<string> {
  try { const me = await telegram.getMe(); return me.username ?? "bot"; } catch { return "bot"; }
}

// ─── Withdrawal proof message ─────────────────────────────────────────────────
function buildProofMessage(
  w: { id: number; amount: number; paymentMethod: string; requestedAt: Date },
  displayName: string,
  status: "pending" | "approved" | "rejected",
  extra?: { approvedAt?: Date; reason?: string }
): string {
  const reqDate = w.requestedAt.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  let statusLine: string;
  let extraLines = "";

  if (status === "pending") {
    statusLine = "🟡 <b>Statut :</b> EN COURS DE TRAITEMENT";
  } else if (status === "approved") {
    statusLine = "🟢 <b>Statut :</b> RETRAIT REÇU ✅";
    const approvedDate = extra?.approvedAt?.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) ?? "—";
    extraLines = `\n✅ <b>Confirmé le :</b> ${approvedDate}`;
  } else {
    statusLine = "🔴 <b>Statut :</b> REFUSÉ ❌";
    if (extra?.reason) extraLines = `\n📝 <b>Raison :</b> <i>${extra.reason}</i>`;
  }

  return (
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `      💸  <b>PREUVE DE RETRAIT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${statusLine}\n\n` +
    `🆔 <b>Référence :</b>  <code>#${String(w.id).padStart(5, "0")}</code>\n` +
    `👤 <b>Bénéficiaire :</b>  ${displayName}\n` +
    `💵 <b>Montant :</b>  <b>${w.amount.toLocaleString("fr-FR")} F</b>\n` +
    `💳 <b>Méthode :</b>  ${w.paymentMethod}\n` +
    `📅 <b>Demande le :</b>  ${reqDate}` +
    `${extraLines}\n` +
    `⏳ <b>Délai estimé :</b>  moins de 1 heure\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦  <b>NETWORK COMMUNITY</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`
  );
}

async function sendWithdrawalProof(
  telegram: Telegraf["telegram"],
  proofChannel: string,
  w: { id: number; amount: number; paymentMethod: string; requestedAt: Date },
  displayName: string
): Promise<{ messageId: number; channelId: string } | null> {
  try {
    const msg = await telegram.sendMessage(proofChannel, buildProofMessage(w, displayName, "pending"), { parse_mode: "HTML" });
    return { messageId: msg.message_id, channelId: proofChannel };
  } catch (err) {
    logger.warn({ err, proofChannel }, "Impossible d'envoyer la preuve de retrait");
    return null;
  }
}

async function editWithdrawalProof(
  telegram: Telegraf["telegram"],
  proofChannelId: string,
  proofMessageId: string,
  w: { id: number; amount: number; paymentMethod: string; requestedAt: Date },
  displayName: string,
  status: "approved" | "rejected",
  extra?: { approvedAt?: Date; reason?: string }
): Promise<void> {
  try {
    await telegram.editMessageText(
      proofChannelId,
      parseInt(proofMessageId, 10),
      undefined,
      buildProofMessage(w, displayName, status, extra),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.warn({ err, proofChannelId, proofMessageId }, "Impossible de modifier la preuve de retrait");
  }
}

// ─── Broadcast engine ─────────────────────────────────────────────────────────
async function getBroadcastTargets(filter: "all" | "active"): Promise<string[]> {
  if (filter === "active") {
    const cutoff = new Date(Date.now() - ACTIVE_USER_DAYS * 24 * 3_600_000);
    const rows = await db.select({ telegramId: usersTable.telegramId }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff)));
    return rows.map((r) => r.telegramId);
  }
  const rows = await db.select({ telegramId: usersTable.telegramId }).from(usersTable)
    .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)));
  return rows.map((r) => r.telegramId);
}

async function executeBroadcast(telegram: Telegraf["telegram"], broadcastId: number): Promise<void> {
  const [bc] = await db.select().from(broadcastsTable).where(eq(broadcastsTable.id, broadcastId));
  if (!bc || bc.status !== "scheduled") return;
  const targets = await getBroadcastTargets(bc.targetFilter as "all" | "active");
  await db.update(broadcastsTable).set({ status: "sending", totalTargets: targets.length, startedAt: new Date() }).where(eq(broadcastsTable.id, broadcastId));
  let sent = 0; let failed = 0; let blocked = 0;
  for (const userId of targets) {
    try {
      if (bc.type === "text") await telegram.sendMessage(userId, bc.content, { parse_mode: "HTML" });
      else if (bc.type === "photo" && bc.mediaFileId) await telegram.sendPhoto(userId, bc.mediaFileId, { caption: bc.content, parse_mode: "HTML" });
      else if (bc.type === "video" && bc.mediaFileId) await telegram.sendVideo(userId, bc.mediaFileId, { caption: bc.content, parse_mode: "HTML" });
      sent++;
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("blocked") || msg.includes("deactivated") || msg.includes("chat not found") || msg.includes("Forbidden")) blocked++;
      else failed++;
    }
    await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
  }
  await db.update(broadcastsTable).set({ status: "completed", sentCount: sent, failedCount: failed, blockedCount: blocked, completedAt: new Date() }).where(eq(broadcastsTable.id, broadcastId));
  logger.info({ broadcastId, sent, failed, blocked }, "Diffusion terminée");
}

async function processScheduledBroadcasts(telegram: Telegraf["telegram"]): Promise<void> {
  const now = new Date();
  const due = await db.select().from(broadcastsTable).where(and(eq(broadcastsTable.status, "scheduled"), lt(broadcastsTable.scheduledAt, now)));
  for (const bc of due) {
    executeBroadcast(telegram, bc.id).catch((err) => logger.error({ err, broadcastId: bc.id }, "Erreur diffusion planifiée"));
  }
}

// ─── Bot factory ──────────────────────────────────────────────────────────────
export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  // ─── Maintenance middleware ───────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const telegramId = String(ctx.from?.id ?? "");
    if (adminIds().includes(telegramId)) return next();
    const settings = await getSettings();
    if (settings.maintenanceMode) { await ctx.reply(settings.maintenanceMessage); return; }
    return next();
  });

  // ─── Scheduled broadcast processor ───────────────────────────────────────
  setInterval(() => {
    processScheduledBroadcasts(bot.telegram).catch((err) => logger.error({ err }, "Erreur vérification diffusions"));
    checkAndSendScheduledReports(bot.telegram, adminIds()).catch((err) => logger.error({ err }, "Erreur rapport auto"));
  }, 60_000);

  // ─── VIP rank helper ──────────────────────────────────────────────────────
  function vipRank(referralCount: number): string {
    if (referralCount >= 100) return "👑 Diamant";
    if (referralCount >= 50)  return "💎 Platine";
    if (referralCount >= 20)  return "🥇 Or";
    if (referralCount >= 5)   return "🥈 Argent";
    return "🥉 Bronze";
  }

  // ─── sendAdminUserProfile ─────────────────────────────────────────────────
  async function sendAdminUserProfile(ctx: any, targetId: string): Promise<void> {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!u) { await ctx.reply("❌ Utilisateur introuvable."); return; }

    // Compute stats
    const taskRows = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, targetId));
    const taskEarnings = taskRows.reduce((s, t) => s + t.rewardAmount, 0);
    const referralEarnings = u.referralCount * REFERRAL_REWARD;
    const bonusEarnings = u.welcomeBonusClaimed ? WELCOME_BONUS : 0;
    const [approved] = await db.select({ s: sql<number>`coalesce(sum(amount),0)::int` })
      .from(withdrawalsTable).where(and(eq(withdrawalsTable.telegramId, targetId), eq(withdrawalsTable.status, "approved")));
    const [pending] = await db.select({ c: sql<number>`count(*)::int` })
      .from(withdrawalsTable).where(and(eq(withdrawalsTable.telegramId, targetId), eq(withdrawalsTable.status, "pending")));
    const totalEarned = u.balance + (approved?.s ?? 0);
    const isActive = (Date.now() - u.createdAt.getTime()) < ACTIVE_USER_DAYS * 24 * 3_600_000;

    const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
    const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ") || "—";
    const rank = vipRank(u.referralCount);
    const statusIcon = u.isBanned ? "🚫 Banni" : isActive ? "🟢 Actif" : "🔴 Inactif";
    const lastSeen = u.updatedAt.toLocaleDateString("fr-FR");
    const joinDate = u.createdAt.toLocaleDateString("fr-FR");

    const profile =
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `     👤  <b>PROFIL UTILISATEUR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🆔 <b>ID :</b>  <code>${u.telegramId}</code>\n` +
      `👤 <b>Pseudo :</b>  ${name}\n` +
      `📛 <b>Nom :</b>  ${fullName}\n` +
      `🏆 <b>Rang :</b>  ${rank}\n\n` +
      `💵 <b>Solde :</b>  <b>${u.balance.toLocaleString("fr-FR")} F</b>\n` +
      `📈 <b>Total gagné :</b>  ${totalEarned.toLocaleString("fr-FR")} F\n` +
      `   ↳ Parrainages : ${referralEarnings.toLocaleString("fr-FR")} F\n` +
      `   ↳ Tâches : ${taskEarnings.toLocaleString("fr-FR")} F\n` +
      `   ↳ Bonus : ${(bonusEarnings).toLocaleString("fr-FR")} F\n\n` +
      `👥 <b>Parrainages :</b>  ${u.referralCount}\n` +
      `📋 <b>Tâches complétées :</b>  ${u.tasksCompletedCount}\n` +
      `✅ <b>Total retiré :</b>  ${(approved?.s ?? 0).toLocaleString("fr-FR")} F\n` +
      `⏳ <b>Retraits en attente :</b>  ${pending?.c ?? 0}\n\n` +
      `📅 <b>Inscription :</b>  ${joinDate}\n` +
      `🕐 <b>Dernière activité :</b>  ${lastSeen}\n` +
      `📊 <b>Statut :</b>  ${statusIcon}\n` +
      `🚨 <b>Fraude :</b>  ${u.flaggedForFraud ? "⚠️ Signalé" : "✅ Non"}\n` +
      `🎁 <b>Bonus bienvenue :</b>  ${u.welcomeBonusClaimed ? "✅ Réclamé" : "⏳ Non réclamé"}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`;

    const buttons = [
      [Markup.button.callback("➕ Ajouter solde", `au_add_${u.telegramId}`), Markup.button.callback("➖ Retirer solde", `au_rem_${u.telegramId}`)],
      [Markup.button.callback("🎁 Envoyer bonus", `au_bonus_${u.telegramId}`), Markup.button.callback("📢 Message direct", `au_dm_${u.telegramId}`)],
      [
        u.isBanned ? Markup.button.callback("✅ Débannir", `au_unban_${u.telegramId}`) : Markup.button.callback("🚫 Bannir", `au_ban_${u.telegramId}`),
        u.flaggedForFraud ? Markup.button.callback("✅ Retirer fraude", `au_unfr_${u.telegramId}`) : Markup.button.callback("⚠️ Signaler fraude", `au_fraud_${u.telegramId}`),
      ],
      [Markup.button.callback("📜 Historique retraits", `au_wh_${u.telegramId}`)],
    ];

    await ctx.reply(profile, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  }

  // =========================================================================
  // CALLBACK ACTIONS
  // =========================================================================

  // ─── verify_membership — onboarding flow ─────────────────────────────────
  bot.action("verify_membership", async (ctx) => {
    await ctx.answerCbQuery("⏳ Vérification en cours...");
    const telegramId = String(ctx.from?.id ?? "");
    const firstName = ctx.from?.first_name ?? "ami(e)";
    const missing = await getMissingChannels(ctx.telegram, telegramId);

    if (missing.length > 0) {
      const list = missing.map((ch) => `❌ ${ch.channelName}`).join("\n");
      await ctx.reply(
        `⚠️ <b>Adhésion incomplète</b>\n\nVous n'avez pas encore rejoint :\n\n${list}\n\nRejoignez ces canaux puis appuyez à nouveau sur ✅ Vérifier.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // All channels verified ✅
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("✅ Parfait ! Tapez /start pour continuer.", mainMenu()); return; }

    const channels = await getActiveChannels();
    const checklist = channels.map((ch) => `✅ <b>${ch.channelName}</b>`).join("\n");

    if (!user.welcomeBonusClaimed) {
      // Give welcome bonus
      const [updated] = await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${WELCOME_BONUS}`, welcomeBonusClaimed: true })
        .where(eq(usersTable.telegramId, telegramId))
        .returning();

      await ctx.reply(
        `🎉 <b>Félicitations, ${firstName} !</b>\n\n` +
        `Vous avez rejoint tous nos canaux officiels :\n\n${checklist}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>Bonus de bienvenue : +${WELCOME_BONUS} F</b>\n` +
        `🎁 Solde actuel : <b>${(updated!.balance).toLocaleString("fr-FR")} F</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 Invitez vos amis et gagnez <b>${REFERRAL_REWARD} F</b> par personne inscrite !`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔗 Inviter des amis maintenant", "show_referral")],
            [Markup.button.callback("🏠 Menu principal", "go_main_menu")],
          ]),
        }
      );
    } else {
      await ctx.reply(
        `✅ <b>Accès confirmé !</b>\n\nVous êtes bien membre de tous nos canaux :\n\n${checklist}`,
        { parse_mode: "HTML", ...mainMenu() }
      );
    }
  });

  // ─── show_referral — sharing buttons ─────────────────────────────────────
  bot.action("show_referral", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? "");
    const botUsername = await getBotUsername(ctx.telegram);
    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const text = `🚀 Rejoins Network Community et gagne de l'argent !\n💰 Bonus de bienvenue + parrainage à ${REFERRAL_REWARD} F par ami !\n\nInscris-toi maintenant :`;
    const encodedText = encodeURIComponent(text);
    const encodedLink = encodeURIComponent(link);

    await ctx.reply(
      `🔗 <b>Votre Lien de Parrainage</b>\n\n` +
      `Partagez et gagnez <b>${REFERRAL_REWARD} F</b> par ami inscrit ! 💰\n\n` +
      `<code>${link}</code>\n\n` +
      `📣 Partagez maintenant :`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.url("📱 Partager sur Telegram", `https://t.me/share/url?url=${encodedLink}&text=${encodedText}`)],
          [Markup.button.url("💬 Partager sur WhatsApp", `https://wa.me/?text=${encodedText}%20${encodedLink}`)],
          [Markup.button.url("📘 Partager sur Facebook", `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`)],
          [Markup.button.callback("🏠 Menu principal", "go_main_menu")],
        ]),
      }
    );
  });

  // ─── go_main_menu ─────────────────────────────────────────────────────────
  bot.action("go_main_menu", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Menu principal :", mainMenu());
  });

  // ─── Broadcast callbacks ──────────────────────────────────────────────────
  bot.action(/^bc_type_(text|photo|video)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const msgType = ctx.match[1] as "text" | "photo" | "video";
    broadcastState.set(adminId, { step: "content", msgType });
    const prompts: Record<string, string> = {
      text: "✏️ Rédigez votre message (HTML supporté) :",
      photo: "🖼️ Envoyez la photo avec légende (optionnelle) :",
      video: "🎥 Envoyez la vidéo avec légende (optionnelle) :",
    };
    await ctx.editMessageText(
      `📢 <b>Nouvelle diffusion — ${msgType === "text" ? "Texte" : msgType === "photo" ? "Photo" : "Vidéo"}</b>\n\n${prompts[msgType]}\n\n/annuler_diffusion pour annuler`,
      { parse_mode: "HTML" }
    );
  });

  bot.action(/^bc_target_(all|active)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state) return;
    state.target = ctx.match[1] as "all" | "active";
    state.step = "schedule_choice";
    broadcastState.set(adminId, state);
    const targetCount = (await getBroadcastTargets(state.target)).length;
    await ctx.reply(
      `👥 Cible : <b>${state.target === "all" ? "Tous les utilisateurs" : `Actifs (${ACTIVE_USER_DAYS}j)`}</b>\n📊 Destinataires : <b>${targetCount}</b>\n\nQuand envoyer ?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📤 Maintenant", "bc_now"), Markup.button.callback("⏰ Planifier", "bc_schedule")],
          [Markup.button.callback("❌ Annuler", "bc_cancel")],
        ]),
      }
    );
  });

  bot.action("bc_now", async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state?.target) return;
    state.scheduledAt = undefined;
    state.step = "confirm";
    broadcastState.set(adminId, state);
    await showBroadcastConfirmation(ctx, state);
  });

  bot.action("bc_schedule", async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state) return;
    state.step = "schedule_time";
    broadcastState.set(adminId, state);
    await ctx.reply(`⏰ <b>Planifier</b>\n\nFormat : <code>JJ/MM/AAAA HH:MM</code>\nEx : <code>25/12/2025 14:30</code>`, { parse_mode: "HTML" });
  });

  bot.action("bc_confirm", async (ctx) => {
    await ctx.answerCbQuery("⏳ Diffusion en cours...");
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state?.content || !state.msgType || !state.target) return;
    broadcastState.delete(adminId);
    const [bc] = await db.insert(broadcastsTable).values({
      type: state.msgType, content: state.content, mediaFileId: state.mediaFileId ?? null,
      status: "scheduled", targetFilter: state.target, scheduledAt: state.scheduledAt ?? null, createdBy: adminId,
    }).returning();
    if (!state.scheduledAt) {
      await ctx.editMessageText(`⏳ <b>Diffusion démarrée !</b>\n🆔 #${bc!.id}\n\nConsultez /admin_diffusions pour les stats.`, { parse_mode: "HTML" });
      executeBroadcast(bot.telegram, bc!.id).catch((err) => logger.error({ err, broadcastId: bc!.id }, "Erreur diffusion"));
    } else {
      await ctx.editMessageText(`✅ <b>Diffusion planifiée !</b>\n🆔 #${bc!.id}\n📅 ${state.scheduledAt.toLocaleString("fr-FR")}`, { parse_mode: "HTML" });
    }
  });

  bot.action("bc_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    broadcastState.delete(String(ctx.from?.id ?? ""));
    await ctx.editMessageText("❌ Diffusion annulée.");
  });

  // Task notification callbacks
  bot.action(/^notify_task_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Notification en cours...");
    const taskId = parseInt(ctx.match[1] ?? "", 10);
    if (isNaN(taskId)) return;
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) return;
    await ctx.editMessageText(`⏳ Envoi pour <b>"${task.title}"</b>...`, { parse_mode: "HTML" });
    const targets = await getBroadcastTargets("all");
    let sent = 0;
    for (const userId of targets) {
      try {
        await ctx.telegram.sendMessage(userId,
          `📋 <b>Nouvelle Tâche !</b>\n\n✨ <b>${task.title}</b>\n📝 ${task.description}\n💰 +<b>${task.rewardAmount} F</b>\n\n➡️ /valider_${task.id}`,
          { parse_mode: "HTML" });
        sent++;
      } catch { }
      await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
    }
    await ctx.reply(`✅ Notification envoyée à <b>${sent}</b> utilisateurs.`, { parse_mode: "HTML" });
  });

  bot.action("notify_skip", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });

  // =========================================================================
  // USER COMMANDS & MENUS
  // =========================================================================

  // ─── /start ───────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const tg = ctx.from;
    if (!tg) return;
    const telegramId = String(tg.id);
    const username = tg.username ?? undefined;
    const firstName = tg.first_name ?? undefined;
    const lastName = tg.last_name ?? undefined;
    const startPayload = ctx.startPayload;
    const referredByTelegramId = startPayload && startPayload !== telegramId ? startPayload : undefined;

    const existing = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));

    if (existing.length === 0) {
      const now = new Date();
      await db.insert(usersTable).values({
        telegramId, username, firstName, lastName,
        referredByTelegramId, balance: 0, referralCount: 0, tasksCompletedCount: 0,
      }).onConflictDoNothing();

      if (referredByTelegramId) {
        const [referrer] = await db.select().from(usersTable).where(eq(usersTable.telegramId, referredByTelegramId));
        if (referrer && !referrer.isBanned && !referrer.flaggedForFraud) {
          const isFraud = await detectFraud(referredByTelegramId, now);
          if (isFraud) {
            await db.update(usersTable).set({ flaggedForFraud: true }).where(eq(usersTable.telegramId, referredByTelegramId));
            const [flaggedRef] = await db.select().from(usersTable).where(eq(usersTable.telegramId, referredByTelegramId));
            if (flaggedRef) sendFraudAlert(bot.telegram, adminIds(), flaggedRef).catch(() => {});
          } else {
            await db.insert(referralsTable).values({ referrerId: referredByTelegramId, referredId: telegramId, rewardAmount: REFERRAL_REWARD }).onConflictDoNothing();
            await db.update(usersTable)
              .set({ balance: sql`${usersTable.balance} + ${REFERRAL_REWARD}`, referralCount: sql`${usersTable.referralCount} + 1` })
              .where(eq(usersTable.telegramId, referredByTelegramId));
            try {
              await ctx.telegram.sendMessage(referredByTelegramId,
                `🎉 <b>${firstName ?? "Un ami"}</b> a rejoint via votre lien !\n<b>+${REFERRAL_REWARD} F</b> ajoutés à votre solde 💰`,
                { parse_mode: "HTML" });
            } catch { }
          }
        }
      }

      // Check required channels
      const channels = await getActiveChannels();
      if (channels.length > 0) {
        const channelList = channels.map((ch) => `📢 ${ch.channelName}`).join("\n");
        await ctx.reply(
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> ! 🎉\n\n` +
          `Pour accéder au bot, rejoignez nos canaux officiels :\n\n${channelList}\n\n` +
          `Une fois membre, cliquez sur ✅ Vérifier pour recevoir votre <b>bonus de bienvenue de ${WELCOME_BONUS} F</b> !`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              ...channels.map((ch) => [Markup.button.url(`📢 ${ch.channelName}`, `https://t.me/${ch.channelId.replace("@", "")}`)]),
              [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
            ]),
          }
        );
      } else {
        await ctx.reply(
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n🎁 Gagnez de l'argent en complétant des tâches et en parrainant vos amis !\n💰 Parrainage : <b>${REFERRAL_REWARD} F</b> | Bonus quotidien : <b>${DAILY_BONUS} F</b>`,
          { parse_mode: "HTML", ...mainMenu() }
        );
      }
    } else {
      await db.update(usersTable).set({ username, firstName, lastName }).where(eq(usersTable.telegramId, telegramId));
      if (!(await requireChannels(ctx))) return;
      await ctx.reply(`🔄 Bon retour, <b>${firstName ?? "ami(e)"}</b> ! 👋`, { parse_mode: "HTML", ...mainMenu() });
    }
  });

  // ─── Mon Solde ────────────────────────────────────────────────────────────
  bot.hears("💰 Mon Solde", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    const [pw] = await db.select({ c: count() }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    await ctx.reply(
      `💰 <b>Mon Solde</b>\n\n` +
      `💵 Disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n` +
      `👥 Parrainages : <b>${user.referralCount}</b>\n` +
      `✅ Tâches complétées : <b>${user.tasksCompletedCount}</b>` +
      ((pw?.c ?? 0) > 0 ? `\n⏳ Retrait en attente : <b>${pw!.c}</b>` : "") +
      `\n\n💡 Retrait minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Mon Lien de Parrainage ───────────────────────────────────────────────
  bot.hears("🔗 Mon Lien de Parrainage", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    const botUsername = await getBotUsername(ctx.telegram);
    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const text = `🚀 Rejoins Network Community et gagne de l'argent !\n💰 Bonus de bienvenue + ${REFERRAL_REWARD} F par parrainage !\n\nInscris-toi :`;
    const encodedText = encodeURIComponent(text);
    const encodedLink = encodeURIComponent(link);
    const refs = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, telegramId));
    await ctx.reply(
      `🔗 <b>Mon Lien de Parrainage</b>\n\nGagnez <b>${REFERRAL_REWARD} F</b> par ami inscrit !\n\n<code>${link}</code>\n\n` +
      `👥 Parrainages : <b>${refs.length}</b>\n💰 Gains totaux : <b>${(refs.length * REFERRAL_REWARD).toLocaleString("fr-FR")} F</b>\n\n📣 Partagez maintenant :`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.url("📱 Telegram", `https://t.me/share/url?url=${encodedLink}&text=${encodedText}`)],
          [Markup.button.url("💬 WhatsApp", `https://wa.me/?text=${encodedText}%20${encodedLink}`)],
          [Markup.button.url("📘 Facebook", `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`)],
        ]),
      }
    );
  });

  // ─── Mes Tâches ──────────────────────────────────────────────────────────
  bot.hears("📋 Mes Tâches", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.isActive, true));
    const completed = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    const completedIds = new Set(completed.map((t) => t.taskId));
    if (tasks.length === 0) { await ctx.reply("📋 Aucune tâche disponible.", mainMenu()); return; }
    const lines = tasks.map((t) => {
      const done = completedIds.has(t.id);
      return `${done ? "✅" : "🔲"} <b>${t.title}</b> — <b>+${t.rewardAmount} F</b>\n   📝 ${t.description}\n   ${done ? "<i>Terminée ✓</i>" : `➡️ /valider_${t.id}`}`;
    });
    await ctx.reply(
      `📋 <b>Mes Tâches</b>\n\nProgression : <b>${completedIds.size}/${tasks.length}</b>\n\n${lines.join("\n\n")}\n\n💡 Complétez ≥${MIN_TASKS_FOR_BONUS} tâche pour débloquer le bonus quotidien.`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Classement ──────────────────────────────────────────────────────────
  bot.hears("🏆 Classement", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    const top = await db.select().from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
      .orderBy(desc(usersTable.referralCount), desc(usersTable.balance)).limit(10);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((u, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = u.username ? `@${u.username}` : (u.firstName ?? "Utilisateur");
      return `${medal} ${name}${u.telegramId === telegramId ? " 👈 <i>vous</i>" : ""}\n   👥 ${u.referralCount} filleuls · 💰 ${u.balance.toLocaleString("fr-FR")} F`;
    });
    await ctx.reply(`🏆 <b>Top Parrains</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...mainMenu() });
  });

  // ─── Bonus Quotidien ──────────────────────────────────────────────────────
  bot.hears("🎁 Bonus Quotidien", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    if (user.tasksCompletedCount < MIN_TASKS_FOR_BONUS) {
      await ctx.reply(
        `🎁 <b>Bonus Quotidien</b>\n\n❌ Complétez au moins <b>${MIN_TASKS_FOR_BONUS} tâche(s)</b> d'abord.\nTâches : <b>${user.tasksCompletedCount}/${MIN_TASKS_FOR_BONUS}</b>\n\n📋 Allez dans Mes Tâches !`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    const now = new Date();
    if (user.lastDailyBonusAt) {
      const hoursSince = (now.getTime() - user.lastDailyBonusAt.getTime()) / 3_600_000;
      if (hoursSince < DAILY_BONUS_HOURS) {
        const next = new Date(user.lastDailyBonusAt.getTime() + DAILY_BONUS_HOURS * 3_600_000);
        const diff = next.getTime() - now.getTime();
        const h = Math.floor(diff / 3_600_000);
        const m = Math.floor((diff % 3_600_000) / 60_000);
        await ctx.reply(`🎁 <b>Bonus Quotidien</b>\n\n⏳ Déjà réclamé. Prochain bonus dans : <b>${h}h ${m}min</b>\n💰 Solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML", ...mainMenu() });
        return;
      }
    }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${DAILY_BONUS}`, lastDailyBonusAt: now })
      .where(eq(usersTable.telegramId, telegramId)).returning();
    await ctx.reply(
      `🎁 <b>Bonus Quotidien Réclamé !</b>\n\n✅ <b>+${DAILY_BONUS} F</b> ajoutés !\n💰 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>\n\n⏰ Revenez demain !`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Retrait ─────────────────────────────────────────────────────────────
  bot.hears("💸 Retrait", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    if (user.balance < MIN_WITHDRAWAL) {
      await ctx.reply(
        `💸 <b>Retrait</b>\n\n❌ Solde insuffisant.\n💰 Solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n📊 Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    const pending = await db.select().from(withdrawalsTable).where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    if (pending.length > 0) { await ctx.reply("⏳ Vous avez déjà un retrait en attente d'approbation.", mainMenu()); return; }
    convState.set(telegramId, { step: "awaiting_amount" });
    await ctx.reply(
      `💸 <b>Demande de Retrait</b>\n\n💰 Solde disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n📊 Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n\nCombien souhaitez-vous retirer ?`,
      { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() }
    );
  });

  // ─── Aide ────────────────────────────────────────────────────────────────
  bot.hears("ℹ️ Aide", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const channels = await getActiveChannels();
    const channelLine = channels.length > 0
      ? `\n\n<b>📢 Canaux officiels :</b>\n${channels.map((c) => `• ${c.channelName}`).join("\n")}`
      : "";
    await ctx.reply(
      `ℹ️ <b>Guide d'utilisation</b>\n\n` +
      `💰 <b>Mon Solde</b> — voir vos fonds\n` +
      `🔗 <b>Mon Lien</b> — parrainage (+${REFERRAL_REWARD} F/ami)\n` +
      `📋 <b>Mes Tâches</b> — missions à compléter\n` +
      `🏆 <b>Classement</b> — top parrains\n` +
      `🎁 <b>Bonus</b> — ${DAILY_BONUS} F/jour (après 1 tâche)\n` +
      `💸 <b>Retrait</b> — minimum ${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F` +
      `${channelLine}`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Annuler ─────────────────────────────────────────────────────────────
  bot.hears("❌ Annuler", async (ctx) => {
    convState.delete(String(ctx.from.id));
    await ctx.reply("❌ Action annulée.", mainMenu());
  });

  // ─── /valider_<id> ───────────────────────────────────────────────────────
  bot.hears(/^\/valider_(\d+)$/, async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    const taskId = parseInt(ctx.match[1] ?? "", 10);
    if (isNaN(taskId)) { await ctx.reply("❌ ID de tâche invalide."); return; }
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task || !task.isActive) { await ctx.reply("❌ Tâche introuvable ou inactive."); return; }
    const existing = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    if (existing.some((t) => t.taskId === taskId)) {
      await ctx.reply(`✅ Vous avez déjà complété <b>"${task.title}"</b>.`, { parse_mode: "HTML" }); return;
    }
    await db.insert(userTasksTable).values({ telegramId, taskId, rewardAmount: task.rewardAmount });
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${task.rewardAmount}`, tasksCompletedCount: sql`${usersTable.tasksCompletedCount} + 1` })
      .where(eq(usersTable.telegramId, telegramId)).returning();
    await ctx.reply(
      `🎉 <b>Tâche complétée !</b>\n\n✅ <b>"${task.title}"</b>\n💰 <b>+${task.rewardAmount} F</b>\n💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── /annuler_diffusion ───────────────────────────────────────────────────
  bot.command("annuler_diffusion", async (ctx) => {
    const adminId = String(ctx.from.id);
    broadcastState.delete(adminId);
    adminSettingState.delete(adminId);
    await ctx.reply("❌ Action annulée.", mainMenu());
  });

  // =========================================================================
  // TEXT / MEDIA CONVERSATION HANDLER
  // =========================================================================
  bot.on("text", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    const isAdminUser = adminIds().includes(telegramId);

    // Admin broadcast conversation
    if (isAdminUser) {
      const bcState = broadcastState.get(telegramId);
      if (bcState?.step === "content" && bcState.msgType === "text") {
        bcState.content = text;
        bcState.step = "target";
        broadcastState.set(telegramId, bcState);
        await showBroadcastPreview(ctx, bcState);
        return;
      }
      if (bcState?.step === "schedule_time") {
        const parsed = parseFrDate(text);
        if (!parsed) { await ctx.reply("❌ Format invalide. Exemple : <code>25/12/2025 14:30</code>", { parse_mode: "HTML" }); return; }
        if (parsed <= new Date()) { await ctx.reply("❌ La date doit être dans le futur."); return; }
        bcState.scheduledAt = parsed;
        bcState.step = "confirm";
        broadcastState.set(telegramId, bcState);
        await showBroadcastConfirmation(ctx, bcState);
        return;
      }
      // Admin user management conversation
      const auState = adminUserState.get(telegramId);
      if (auState) {
        const { step, targetId } = auState;
        if (step === "au_add_amount" || step === "au_bonus_amount") {
          const amount = parseInt(text.replace(/[\s\u00a0,\.]/g, ""), 10);
          if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Montant invalide."); return; }
          adminUserState.delete(telegramId);
          const [updated] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${amount}` })
            .where(eq(usersTable.telegramId, targetId)).returning();
          if (!updated) { await ctx.reply("❌ Utilisateur introuvable."); return; }
          const label = step === "au_bonus_amount" ? "Bonus" : "Solde ajusté";
          if (step === "au_bonus_amount") {
            try {
              await ctx.telegram.sendMessage(targetId,
                `🎁 <b>Bonus Reçu !</b>\n\nUn administrateur vous a attribué <b>+${amount.toLocaleString("fr-FR")} F</b> !\n💵 Nouveau solde : <b>${updated.balance.toLocaleString("fr-FR")} F</b>`,
                { parse_mode: "HTML" });
            } catch { }
          }
          await ctx.reply(`✅ <b>${label} :</b> +${amount.toLocaleString("fr-FR")} F\n💵 Nouveau solde : <b>${updated.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
          await sendAdminUserProfile(ctx, targetId);
          return;
        }
        if (step === "au_rem_amount") {
          const amount = parseInt(text.replace(/[\s\u00a0,\.]/g, ""), 10);
          if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Montant invalide."); return; }
          adminUserState.delete(telegramId);
          const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
          if (!u) { await ctx.reply("❌ Utilisateur introuvable."); return; }
          const newBal = Math.max(0, u.balance - amount);
          const [updated] = await db.update(usersTable).set({ balance: newBal }).where(eq(usersTable.telegramId, targetId)).returning();
          await ctx.reply(`✅ <b>Solde retiré :</b> -${amount.toLocaleString("fr-FR")} F\n💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
          await sendAdminUserProfile(ctx, targetId);
          return;
        }
        if (step === "au_dm_content") {
          adminUserState.delete(telegramId);
          try {
            await ctx.telegram.sendMessage(targetId, `📢 <b>Message de l'Administration</b>\n\n${text}`, { parse_mode: "HTML" });
            await ctx.reply("✅ Message envoyé avec succès.");
          } catch { await ctx.reply("❌ Impossible d'envoyer le message (utilisateur peut avoir bloqué le bot)."); }
          return;
        }
      }

      const settingStep = adminSettingState.get(telegramId);
      if (settingStep?.step === "welcome_content") {
        adminSettingState.delete(telegramId);
        await setSetting(SETTING_KEYS.WELCOME_MESSAGE, text, telegramId);
        await ctx.reply(
          `✅ <b>Message de bienvenue mis à jour !</b>\n\nAperçu :\n\n${text.replace("{prenom}", "Jean").replace("{parrainage}", String(REFERRAL_REWARD)).replace("{bonus}", String(DAILY_BONUS))}`,
          { parse_mode: "HTML", ...mainMenu() }
        );
        return;
      }
      if (settingStep?.step === "maintenance_message") {
        adminSettingState.delete(telegramId);
        await setSetting(SETTING_KEYS.MAINTENANCE_MESSAGE, text, telegramId);
        await ctx.reply(`✅ Message de maintenance mis à jour.`, mainMenu());
        return;
      }
    }

    // User withdrawal conversation
    const state = convState.get(telegramId);
    if (!state) return;

    if (state.step === "awaiting_amount") {
      const amount = parseInt(text.replace(/[\s\u00a0,\.]/g, ""), 10);
      if (isNaN(amount) || amount < MIN_WITHDRAWAL) {
        await ctx.reply(`❌ Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" }); return;
      }
      const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
      if (!user || amount > user.balance) {
        await ctx.reply(`❌ Solde insuffisant : <b>${(user?.balance ?? 0).toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
        convState.delete(telegramId); await ctx.reply("Annulé.", mainMenu()); return;
      }
      state.step = "awaiting_method"; state.amount = amount;
      convState.set(telegramId, state);
      await ctx.reply("💳 Choisissez votre méthode de paiement :", {
        ...Markup.keyboard([["📱 Mobile Money", "🏦 Virement Bancaire"], ["💰 PayPal", "🔐 Crypto (USDT/BTC)"], ["❌ Annuler"]]).resize(),
      });
      return;
    }

    if (state.step === "awaiting_method") {
      const valid = ["📱 Mobile Money", "🏦 Virement Bancaire", "💰 PayPal", "🔐 Crypto (USDT/BTC)"];
      if (!valid.includes(text)) { await ctx.reply("❌ Choisissez une option du clavier."); return; }
      state.step = "awaiting_details"; state.method = text;
      convState.set(telegramId, state);
      const prompts: Record<string, string> = {
        "📱 Mobile Money": "Votre numéro Mobile Money (avec indicatif pays) :",
        "🏦 Virement Bancaire": "IBAN + Nom du titulaire :",
        "💰 PayPal": "Adresse e-mail PayPal :",
        "🔐 Crypto (USDT/BTC)": "Adresse de wallet (précisez le réseau, ex: TRC20) :",
      };
      await ctx.reply(`📝 <b>${prompts[text] ?? "Vos coordonnées :"}</b>`, { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() });
      return;
    }

    if (state.step === "awaiting_details") {
      if (!state.amount || !state.method) { convState.delete(telegramId); await ctx.reply("❌ Erreur.", mainMenu()); return; }

      const [withdrawal] = await db.insert(withdrawalsTable).values({
        telegramId, amount: state.amount, paymentMethod: state.method, paymentDetails: text, status: "pending",
      }).returning();
      const [updatedUser] = await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${state.amount}` })
        .where(eq(usersTable.telegramId, telegramId)).returning();

      const savedAmount = state.amount;
      const savedMethod = state.method;
      convState.delete(telegramId);

      // Confirmation to user
      await ctx.reply(
        `✅ <b>Retrait enregistré !</b>\n\n🆔 Référence : <b>#${String(withdrawal!.id).padStart(5, "0")}</b>\n💰 Montant : <b>${savedAmount.toLocaleString("fr-FR")} F</b>\n💳 Méthode : <b>${savedMethod}</b>\n⏳ Statut : <b>En attente</b>\n⏱️ Délai estimé : <b>moins de 1 heure</b>\n\n💵 Solde restant : <b>${updatedUser!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );

      // Get user display name
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
      const displayName = u?.username ? `@${u.username}` : (u?.firstName ?? telegramId);

      // Send proof message to withdrawal channel
      const settings = await getSettings();
      const proofResult = await sendWithdrawalProof(bot.telegram, settings.withdrawalProofChannel, withdrawal!, displayName);
      if (proofResult) {
        await db.update(withdrawalsTable)
          .set({ proofMessageId: String(proofResult.messageId), proofChannelId: proofResult.channelId })
          .where(eq(withdrawalsTable.id, withdrawal!.id));
      }

      // Large withdrawal alert
      await sendLargeWithdrawalAlert(bot.telegram, adminIds(), { id: withdrawal!.id, amount: savedAmount, paymentMethod: savedMethod, telegramId }, displayName).catch(() => {});

      // Notify admins
      for (const adminId of adminIds()) {
        try {
          await ctx.telegram.sendMessage(adminId,
            `💸 <b>Nouveau Retrait #${withdrawal!.id}</b>\n\n👤 ${displayName} (${telegramId})\n💰 ${savedAmount.toLocaleString("fr-FR")} F\n💳 ${savedMethod}\n📝 <code>${text}</code>\n\n✅ /admin_approuver_${withdrawal!.id}\n❌ /admin_rejeter_${withdrawal!.id} <raison>`,
            { parse_mode: "HTML" });
        } catch { }
      }
    }
  });

  // Photo/Video handlers for broadcast
  bot.on("photo", async (ctx) => {
    const adminId = String(ctx.from.id);
    if (!adminIds().includes(adminId)) return;
    const bcState = broadcastState.get(adminId);
    if (!bcState || bcState.step !== "content" || bcState.msgType !== "photo") return;
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) return;
    bcState.mediaFileId = photo.file_id;
    bcState.content = ctx.message.caption ?? "";
    bcState.step = "target";
    broadcastState.set(adminId, bcState);
    await showBroadcastPreview(ctx, bcState);
  });

  bot.on("video", async (ctx) => {
    const adminId = String(ctx.from.id);
    if (!adminIds().includes(adminId)) return;
    const bcState = broadcastState.get(adminId);
    if (!bcState || bcState.step !== "content" || bcState.msgType !== "video") return;
    bcState.mediaFileId = ctx.message.video.file_id;
    bcState.content = ctx.message.caption ?? "";
    bcState.step = "target";
    broadcastState.set(adminId, bcState);
    await showBroadcastPreview(ctx, bcState);
  });

  // =========================================================================
  // ADMIN COMMANDS
  // =========================================================================

  bot.command("admin", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply(
      `🔧 <b>Panneau Administrateur</b>\n\n` +
      `📊 /admin_stats\n\n` +
      `📢 <b>Diffusions</b>\n/admin_broadcast · /admin_diffusions\n\n` +
      `⚙️ <b>Paramètres</b>\n/admin_parametres · /admin_bienvenue\n/admin_maintenance on/off\n\n` +
      `👥 <b>Utilisateurs</b>\n/admin_solde · /admin_bonus · /admin_ban · /admin_unban · /admin_fraude\n\n` +
      `📋 <b>Tâches</b>\n/admin_tache · /admin_taches\n\n` +
      `📢 <b>Canaux</b>\n/admin_canal\n\n` +
      `💸 <b>Retraits</b>\n/admin_retraits · /admin_approuver_<id> · /admin_rejeter_<id>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_broadcast", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    broadcastState.set(adminId, { step: "type" });
    await ctx.reply(
      `📢 <b>Nouvelle Diffusion</b>\n\nChoisissez le type de message :`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📝 Texte", "bc_type_text"), Markup.button.callback("🖼️ Photo", "bc_type_photo"), Markup.button.callback("🎥 Vidéo", "bc_type_video")],
          [Markup.button.callback("❌ Annuler", "bc_cancel")],
        ]),
      }
    );
  });

  bot.command("admin_diffusions", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const broadcasts = await db.select().from(broadcastsTable).orderBy(desc(broadcastsTable.createdAt)).limit(10);
    if (broadcasts.length === 0) { await ctx.reply("📢 Aucune diffusion enregistrée."); return; }
    const icons: Record<string, string> = { scheduled: "⏰", sending: "📡", completed: "✅", failed: "❌", cancelled: "🚫" };
    const lines = broadcasts.map((b) => {
      const stats = b.status === "completed" ? `📤 ${b.sentCount} · ❌ ${b.failedCount} · 🚫 ${b.blockedCount}` : `🎯 ${b.totalTargets}`;
      return `${icons[b.status] ?? "❓"} <b>#${b.id}</b> — ${b.type} — ${(b.scheduledAt ?? b.createdAt).toLocaleDateString("fr-FR")}\n   ${stats} — <i>${b.content.slice(0, 40)}…</i>`;
    });
    await ctx.reply(`📢 <b>Diffusions (${broadcasts.length})</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("admin_stats", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const [uc] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
    const [rc] = await db.select({ c: sql<number>`count(*)::int` }).from(referralsTable);
    const [pts] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(usersTable);
    const [tc] = await db.select({ c: sql<number>`count(*)::int` }).from(tasksTable).where(eq(tasksTable.isActive, true));
    const [pw] = await db.select({ c: sql<number>`count(*)::int` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending"));
    const [aw] = await db.select({ s: sql<number>`coalesce(sum(amount),0)::int` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "approved"));
    const [fc] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.flaggedForFraud, true));
    const cutoff = new Date(Date.now() - ACTIVE_USER_DAYS * 24 * 3_600_000);
    const [active] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff)));
    await ctx.reply(
      `📊 <b>Statistiques</b>\n\n` +
      `👥 Utilisateurs : <b>${uc?.c ?? 0}</b>\n📅 Actifs ${ACTIVE_USER_DAYS}j : <b>${active?.c ?? 0}</b>\n` +
      `🔗 Parrainages : <b>${rc?.c ?? 0}</b>\n💰 Fonds distribués : <b>${(pts?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `📋 Tâches actives : <b>${tc?.c ?? 0}</b>\n⏳ Retraits en attente : <b>${pw?.c ?? 0}</b>\n` +
      `✅ Total retiré : <b>${(aw?.s ?? 0).toLocaleString("fr-FR")} F</b>\n🚨 Fraudes : <b>${fc?.c ?? 0}</b>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_parametres", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const maintenanceMode = (await getSetting(SETTING_KEYS.MAINTENANCE_MODE)) === "true";
    const welcomeMsg = await getSetting(SETTING_KEYS.WELCOME_MESSAGE);
    const proofChannel = (await getSetting(WITHDRAWAL_PROOF_CHANNEL_KEY)) ?? DEFAULT_PROOF_CHANNEL;
    await ctx.reply(
      `⚙️ <b>Paramètres du Bot</b>\n\n` +
      `🔧 Maintenance : <b>${maintenanceMode ? "✅ ON" : "❌ OFF"}</b>\n` +
      `👋 Message de bienvenue : <b>${welcomeMsg ? "Personnalisé" : "Par défaut"}</b>\n` +
      `💸 Canal preuves : <b>${proofChannel}</b>\n\n` +
      `/admin_bienvenue — éditer le message de bienvenue\n` +
      `/admin_maintenance on|off — mode maintenance\n` +
      `/admin_proof_channel @canal — changer le canal de preuves`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_bienvenue", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const current = await getSetting(SETTING_KEYS.WELCOME_MESSAGE);
    adminSettingState.set(String(ctx.from.id), { step: "welcome_content" });
    await ctx.reply(
      `👋 <b>Message de Bienvenue</b>\n\n` +
      (current ? `Actuel :\n<i>${current}</i>\n\n` : "Aucun message personnalisé.\n\n") +
      `Variables : <code>{prenom}</code> <code>{parrainage}</code> <code>{bonus}</code>\n\nRédigez le nouveau message :\n/annuler_diffusion pour annuler`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_maintenance", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    const arg = ctx.message.text.split(" ")[1]?.toLowerCase();
    if (arg === "on") {
      await setSetting(SETTING_KEYS.MAINTENANCE_MODE, "true", adminId);
      await ctx.reply("🔧 Mode maintenance <b>activé</b>.", { parse_mode: "HTML" });
    } else if (arg === "off") {
      await setSetting(SETTING_KEYS.MAINTENANCE_MODE, "false", adminId);
      await ctx.reply("✅ Mode maintenance <b>désactivé</b>.", { parse_mode: "HTML" });
    } else {
      const current = (await getSetting(SETTING_KEYS.MAINTENANCE_MODE)) === "true";
      await ctx.reply(`🔧 Maintenance : <b>${current ? "ON" : "OFF"}</b>\n\nUsage : /admin_maintenance on|off`, { parse_mode: "HTML" });
    }
  });

  bot.command("admin_proof_channel", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const channel = ctx.message.text.split(" ")[1];
    if (!channel) { await ctx.reply("Usage : /admin_proof_channel @canal"); return; }
    const normalized = channel.startsWith("@") ? channel : `@${channel}`;
    await setSetting(WITHDRAWAL_PROOF_CHANNEL_KEY, normalized, String(ctx.from.id));
    await ctx.reply(`✅ Canal de preuves mis à jour : <b>${normalized}</b>`, { parse_mode: "HTML" });
  });

  // Admin user management
  bot.command("admin_solde", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1]; const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount)) { await ctx.reply("Usage : /admin_solde <telegramId> <montant>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    const [updated] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${amount}` }).where(eq(usersTable.telegramId, targetId)).returning();
    await ctx.reply(`✅ Solde mis à jour : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
  });

  bot.command("admin_bonus", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1]; const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount) || amount <= 0) { await ctx.reply("Usage : /admin_bonus <telegramId> <montant>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    const [updated] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${amount}` }).where(eq(usersTable.telegramId, targetId)).returning();
    try {
      await ctx.telegram.sendMessage(targetId,
        `🎁 <b>Bonus Reçu !</b>\n\nUn administrateur vous a attribué <b>+${amount.toLocaleString("fr-FR")} F</b> !\n💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Bonus <b>+${amount.toLocaleString("fr-FR")} F</b> attribué.`, { parse_mode: "HTML" });
  });

  bot.command("admin_ban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage : /admin_ban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Introuvable."); return; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "🚫 Votre compte a été suspendu."); } catch { }
    await ctx.reply(`🔨 ${targetId} suspendu.`);
  });

  bot.command("admin_unban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage : /admin_unban <telegramId>"); return; }
    await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "✅ Votre compte a été réactivé !"); } catch { }
    await ctx.reply(`✅ ${targetId} réactivé.`);
  });

  bot.command("admin_fraude", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const flagged = await db.select().from(usersTable).where(eq(usersTable.flaggedForFraud, true)).limit(20);
    if (flagged.length === 0) { await ctx.reply("✅ Aucun compte signalé."); return; }
    const lines = flagged.map((u) => `• ${u.username ? `@${u.username}` : (u.firstName ?? "—")} (${u.telegramId}) — ${u.referralCount} parr. ${u.isBanned ? "🔨" : ""}`);
    await ctx.reply(`🚨 <b>Comptes Signalés (${flagged.length})</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command("admin_tache", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const text = ctx.message.text.replace("/admin_tache", "").trim();
    const parts = text.split("|");
    const firstPart = (parts[0] ?? "").trim().split(" ");
    const reward = parseInt(firstPart[0] ?? "", 10);
    const title = firstPart.slice(1).join(" ").trim();
    const description = (parts[1] ?? "").trim();
    if (isNaN(reward) || !title || !description) {
      await ctx.reply("Usage : /admin_tache <récompense> <titre> | <description>"); return;
    }
    const [task] = await db.insert(tasksTable).values({ title, description, rewardAmount: reward, isActive: true }).returning();
    await ctx.reply(
      `✅ Tâche créée !\n🆔 <b>#${task!.id}</b> — <b>${title}</b>\n💰 +${reward} F\n\n🔔 Notifier tous les utilisateurs ?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Oui, notifier", `notify_task_${task!.id}`), Markup.button.callback("❌ Non", "notify_skip")],
        ]),
      }
    );
  });

  bot.command("admin_taches", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    if (tasks.length === 0) { await ctx.reply("Aucune tâche."); return; }
    const lines = tasks.map((t) => `${t.isActive ? "✅" : "❌"} [${t.id}] <b>${t.title}</b> — +${t.rewardAmount} F\n   ${t.description}`);
    await ctx.reply(`📋 <b>Toutes les Tâches</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("admin_canal", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    const text = ctx.message.text.replace("/admin_canal", "").trim();
    const parts = text.split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? "";

    if (!sub || sub === "liste") {
      const channels = await db.select().from(requiredChannelsTable).orderBy(requiredChannelsTable.id);
      if (channels.length === 0) { await ctx.reply("📢 Aucun canal. Ajouter : /admin_canal ajouter @canal Nom"); return; }
      const lines = channels.map((c) => `${c.isActive ? "✅" : "❌"} [${c.id}] <b>${c.channelName}</b>\n   <code>${c.channelId}</code>`);
      await ctx.reply(`📢 <b>Canaux (${channels.length})</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" }); return;
    }
    if (sub === "ajouter") {
      const channelId = parts[1]; const channelName = parts.slice(2).join(" ").trim();
      if (!channelId || !channelName) { await ctx.reply("Usage : /admin_canal ajouter @canal Nom"); return; }
      const normalizedId = channelId.startsWith("@") ? channelId : `@${channelId}`;
      try { await ctx.telegram.getChat(normalizedId); } catch {
        await ctx.reply(`❌ Canal introuvable : <code>${normalizedId}</code>`, { parse_mode: "HTML" }); return;
      }
      const existing = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.channelId, normalizedId));
      if (existing.length > 0) {
        if (!existing[0]!.isActive) {
          await db.update(requiredChannelsTable).set({ isActive: true, channelName }).where(eq(requiredChannelsTable.channelId, normalizedId));
          await ctx.reply(`✅ <b>${channelName}</b> réactivé !`, { parse_mode: "HTML" });
        } else { await ctx.reply("⚠️ Canal déjà configuré."); }
        return;
      }
      const [ch] = await db.insert(requiredChannelsTable).values({ channelId: normalizedId, channelName, addedBy: adminId, isActive: true }).returning();
      await ctx.reply(`✅ Canal <b>${channelName}</b> ajouté (ID: ${ch!.id}).`, { parse_mode: "HTML" }); return;
    }
    if (sub === "supprimer") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal supprimer <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Introuvable."); return; }
      await db.delete(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`🗑️ <b>${ch.channelName}</b> supprimé.`, { parse_mode: "HTML" }); return;
    }
    if (sub === "desactiver") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal desactiver <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Introuvable."); return; }
      await db.update(requiredChannelsTable).set({ isActive: false }).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`❌ <b>${ch.channelName}</b> désactivé.`, { parse_mode: "HTML" }); return;
    }
    if (sub === "activer") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal activer <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Introuvable."); return; }
      await db.update(requiredChannelsTable).set({ isActive: true }).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`✅ <b>${ch.channelName}</b> activé.`, { parse_mode: "HTML" }); return;
    }
    await ctx.reply("Sous-commandes : liste | ajouter @canal Nom | supprimer <id> | desactiver <id> | activer <id>");
  });

  bot.command("admin_retraits", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const pending = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending")).orderBy(withdrawalsTable.requestedAt).limit(20);
    if (pending.length === 0) { await ctx.reply("✅ Aucun retrait en attente."); return; }
    for (const w of pending) {
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, w.telegramId));
      const name = u?.username ? `@${u.username}` : (u?.firstName ?? w.telegramId);
      await ctx.reply(
        `💸 <b>Retrait #${w.id}</b>\n👤 ${name} (${w.telegramId})\n💰 ${w.amount.toLocaleString("fr-FR")} F\n💳 ${w.paymentMethod}\n📝 <code>${w.paymentDetails}</code>\n\n✅ /admin_approuver_${w.id}\n❌ /admin_rejeter_${w.id} <raison>`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.hears(/^\/admin_approuver_(\d+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const wId = parseInt(ctx.match[1] ?? "", 10);
    if (isNaN(wId)) { await ctx.reply("❌ ID invalide."); return; }
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, wId));
    if (!w || w.status !== "pending") { await ctx.reply("❌ Introuvable ou déjà traité."); return; }
    const now = new Date();
    await db.update(withdrawalsTable).set({ status: "approved", processedAt: now }).where(eq(withdrawalsTable.id, wId));

    // Edit proof message → approved
    if (w.proofMessageId && w.proofChannelId) {
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, w.telegramId));
      const displayName = u?.username ? `@${u.username}` : (u?.firstName ?? w.telegramId);
      await editWithdrawalProof(bot.telegram, w.proofChannelId, w.proofMessageId, w, displayName, "approved", { approvedAt: now });
    }

    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `✅ <b>Retrait Approuvé !</b>\n\n🆔 #${String(w.id).padStart(5, "0")}\n💰 ${w.amount.toLocaleString("fr-FR")} F via ${w.paymentMethod}\n🎉 Votre paiement est en cours de traitement.`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Retrait #${wId} approuvé. Preuve mise à jour.`);
  });

  bot.hears(/^\/admin_rejeter_(\d+)(?:\s+(.+))?$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const wId = parseInt(ctx.match[1] ?? "", 10);
    const reason = ctx.match[2]?.trim() ?? "Aucune raison précisée";
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, wId));
    if (!w || w.status !== "pending") { await ctx.reply("❌ Introuvable ou déjà traité."); return; }
    await db.update(withdrawalsTable).set({ status: "rejected", processedAt: new Date(), adminNote: reason }).where(eq(withdrawalsTable.id, wId));
    const [restored] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${w.amount}` }).where(eq(usersTable.telegramId, w.telegramId)).returning();

    // Edit proof message → rejected
    if (w.proofMessageId && w.proofChannelId) {
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, w.telegramId));
      const displayName = u?.username ? `@${u.username}` : (u?.firstName ?? w.telegramId);
      await editWithdrawalProof(bot.telegram, w.proofChannelId, w.proofMessageId, w, displayName, "rejected", { reason });
    }

    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `❌ <b>Retrait Refusé</b>\n\n🆔 #${String(w.id).padStart(5, "0")}\n📋 Raison : <i>${reason}</i>\n💵 Solde recrédité : <b>${restored!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`❌ Retrait #${wId} refusé. Solde recrédité. Preuve mise à jour.`);
  });

  // =========================================================================
  // ADMIN USER MANAGEMENT CALLBACKS
  // =========================================================================

  bot.action(/^au_add_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    adminUserState.set(adminId, { step: "au_add_amount", targetId });
    await ctx.reply(`➕ <b>Ajouter au solde</b>\n\nCible : <code>${targetId}</code>\n\nMontant à ajouter (en F) ?\n/annuler_diffusion pour annuler`, { parse_mode: "HTML" });
  });

  bot.action(/^au_rem_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    adminUserState.set(adminId, { step: "au_rem_amount", targetId });
    await ctx.reply(`➖ <b>Retirer du solde</b>\n\nCible : <code>${targetId}</code>\n\nMontant à retirer (en F) ?\n/annuler_diffusion pour annuler`, { parse_mode: "HTML" });
  });

  bot.action(/^au_bonus_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    adminUserState.set(adminId, { step: "au_bonus_amount", targetId });
    await ctx.reply(`🎁 <b>Envoyer un bonus</b>\n\nCible : <code>${targetId}</code>\n\nMontant du bonus (en F) ?\n/annuler_diffusion pour annuler`, { parse_mode: "HTML" });
  });

  bot.action(/^au_dm_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    adminUserState.set(adminId, { step: "au_dm_content", targetId });
    await ctx.reply(`📢 <b>Message Direct</b>\n\nCible : <code>${targetId}</code>\n\nRédigez votre message (HTML supporté) :\n/annuler_diffusion pour annuler`, { parse_mode: "HTML" });
  });

  bot.action(/^au_ban_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Bannissement...");
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!u) { await ctx.reply("❌ Introuvable."); return; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "🚫 Votre compte a été suspendu par l'administration."); } catch { }
    await ctx.reply(`🔨 <b>${u.username ? `@${u.username}` : u.firstName ?? targetId}</b> banni avec succès.`, { parse_mode: "HTML" });
    await sendAdminUserProfile(ctx, targetId);
  });

  bot.action(/^au_unban_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Réactivation...");
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!u) { await ctx.reply("❌ Introuvable."); return; }
    await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "✅ Votre compte a été réactivé. Bienvenue de retour !"); } catch { }
    await ctx.reply(`✅ <b>${u.username ? `@${u.username}` : u.firstName ?? targetId}</b> débanni avec succès.`, { parse_mode: "HTML" });
    await sendAdminUserProfile(ctx, targetId);
  });

  bot.action(/^au_fraud_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Signalement...");
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    await db.update(usersTable).set({ flaggedForFraud: true }).where(eq(usersTable.telegramId, targetId));
    await ctx.reply(`⚠️ Compte <code>${targetId}</code> signalé pour fraude.`, { parse_mode: "HTML" });
    await sendAdminUserProfile(ctx, targetId);
  });

  bot.action(/^au_unfr_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Retrait du signalement...");
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    await db.update(usersTable).set({ flaggedForFraud: false }).where(eq(usersTable.telegramId, targetId));
    await ctx.reply(`✅ Signalement de fraude retiré pour <code>${targetId}</code>.`, { parse_mode: "HTML" });
    await sendAdminUserProfile(ctx, targetId);
  });

  bot.action(/^au_wh_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    if (!adminIds().includes(adminId)) return;
    const targetId = ctx.match[1]!;
    const withdrawals = await db.select().from(withdrawalsTable)
      .where(eq(withdrawalsTable.telegramId, targetId))
      .orderBy(desc(withdrawalsTable.requestedAt)).limit(10);
    if (withdrawals.length === 0) { await ctx.reply("📜 Aucun retrait trouvé pour cet utilisateur."); return; }
    const statusIcons: Record<string, string> = { pending: "⏳", approved: "✅", rejected: "❌" };
    const lines = withdrawals.map((w) =>
      `${statusIcons[w.status] ?? "?"} <b>#${String(w.id).padStart(5, "0")}</b>  ${w.amount.toLocaleString("fr-FR")} F  ${w.paymentMethod}\n   📅 ${w.requestedAt.toLocaleDateString("fr-FR")}${w.adminNote ? `  ·  <i>${w.adminNote}</i>` : ""}`
    );
    await ctx.reply(`📜 <b>Historique Retraits</b>\n(<code>${targetId}</code>)\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // =========================================================================
  // ADMIN USER COMMANDS
  // =========================================================================

  bot.command("admin_user", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const query = ctx.message.text.replace("/admin_user", "").trim();
    if (!query) {
      await ctx.reply(
        `👤 <b>Recherche d'utilisateur</b>\n\nUsage :\n` +
        `• /admin_user <code>123456789</code> — par ID Telegram\n` +
        `• /admin_user <code>@username</code> — par nom d'utilisateur\n` +
        `• /admin_user ref:<code>123456789</code> — par code de parrainage\n\n` +
        `<i>Le code de parrainage est l'ID Telegram du parrain.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    let targetId: string | null = null;

    if (query.startsWith("ref:")) {
      // Search by referral code (= referrer's telegramId)
      const refCode = query.slice(4).trim();
      const [referred] = await db.select().from(usersTable)
        .where(eq(usersTable.referredByTelegramId, refCode)).limit(1);
      if (referred) {
        // Show referrer profile
        targetId = refCode;
      } else {
        await ctx.reply(`❌ Aucun utilisateur parrainé via le code <code>${refCode}</code>.`, { parse_mode: "HTML" });
        return;
      }
    } else if (query.startsWith("@")) {
      const uname = query.slice(1).toLowerCase();
      const [u] = await db.select().from(usersTable)
        .where(sql`lower(${usersTable.username}) = ${uname}`);
      if (!u) { await ctx.reply(`❌ Utilisateur <b>${query}</b> introuvable.`, { parse_mode: "HTML" }); return; }
      targetId = u.telegramId;
    } else {
      // By telegramId
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, query));
      if (!u) { await ctx.reply(`❌ ID <code>${query}</code> introuvable.`, { parse_mode: "HTML" }); return; }
      targetId = u.telegramId;
    }

    await sendAdminUserProfile(ctx, targetId);
  });

  // ─── /admin_top — top earners ─────────────────────────────────────────────
  bot.command("admin_top", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const arg = ctx.message.text.split(" ")[1]?.toLowerCase() ?? "solde";

    const [topBalance, topRefs, topTasks] = await Promise.all([
      db.select().from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
        .orderBy(desc(usersTable.balance)).limit(5),
      db.select().from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
        .orderBy(desc(usersTable.referralCount)).limit(5),
      db.select().from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
        .orderBy(desc(usersTable.tasksCompletedCount)).limit(5),
    ]);

    const fmt = (u: typeof usersTable.$inferSelect, i: number, field: "balance" | "refs" | "tasks") => {
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
      const name = u.username ? `@${u.username}` : (u.firstName ?? u.telegramId);
      const val = field === "balance" ? `${u.balance.toLocaleString("fr-FR")} F`
                : field === "refs" ? `${u.referralCount} filleuls`
                : `${u.tasksCompletedCount} tâches`;
      return `${medals[i] ?? `${i + 1}.`} ${name} — <b>${val}</b>`;
    };

    await ctx.reply(
      `🏆 <b>Top Utilisateurs</b>\n\n` +
      `💰 <b>Meilleurs Soldes</b>\n${topBalance.map((u, i) => fmt(u, i, "balance")).join("\n")}\n\n` +
      `👥 <b>Meilleurs Parrains</b>\n${topRefs.map((u, i) => fmt(u, i, "refs")).join("\n")}\n\n` +
      `📋 <b>Meilleurs Actifs (Tâches)</b>\n${topTasks.map((u, i) => fmt(u, i, "tasks")).join("\n")}`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /admin_actifs — active/inactive users ────────────────────────────────
  bot.command("admin_actifs", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const cutoff30 = new Date(Date.now() - 30 * 24 * 3_600_000);
    const cutoff7  = new Date(Date.now() - 7  * 24 * 3_600_000);
    const cutoff1  = new Date(Date.now() - 1  * 24 * 3_600_000);

    const [total, last30, last7, last1, banned, fraud] = await Promise.all([
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable),
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff30))),
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff7))),
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable)
        .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff1))),
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.isBanned, true)),
      db.select({ c: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.flaggedForFraud, true)),
    ]);

    const totalN = total[0]?.c ?? 0;
    const active30 = last30[0]?.c ?? 0;
    const active7  = last7[0]?.c ?? 0;
    const active1  = last1[0]?.c ?? 0;
    const bannedN  = banned[0]?.c ?? 0;
    const fraudN   = fraud[0]?.c ?? 0;
    const inactive = totalN - active30 - bannedN - fraudN;

    const pct = (n: number) => totalN > 0 ? `${Math.round((n / totalN) * 100)}%` : "0%";
    const bar = (n: number) => "█".repeat(Math.min(10, Math.round((n / Math.max(totalN, 1)) * 10))) || "░";

    await ctx.reply(
      `📊 <b>Activité Utilisateurs</b>\n\n` +
      `👥 Total inscrit : <b>${totalN}</b>\n\n` +
      `🟢 <b>Actifs (30j) :</b>  ${active30}  <i>${pct(active30)}</i>\n${bar(active30)}\n` +
      `🟡 <b>Actifs (7j) :</b>   ${active7}  <i>${pct(active7)}</i>\n${bar(active7)}\n` +
      `⚡ <b>Actifs (24h) :</b>  ${active1}  <i>${pct(active1)}</i>\n${bar(active1)}\n\n` +
      `🔴 <b>Inactifs (>30j) :</b>  ${inactive}  <i>${pct(inactive)}</i>\n` +
      `🚫 <b>Bannis :</b>  ${bannedN}\n` +
      `⚠️ <b>Fraudes :</b>  ${fraudN}`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /admin_search — search by username partial match ─────────────────────
  bot.command("admin_search", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const query = ctx.message.text.replace("/admin_search", "").trim();
    if (!query || query.length < 2) { await ctx.reply("Usage : /admin_search <terme> (min 2 caractères)"); return; }
    const term = query.replace("@", "").toLowerCase();
    const results = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.username}) like ${"%" + term + "%"} or lower(${usersTable.firstName}) like ${"%" + term + "%"}`)
      .limit(8);
    if (results.length === 0) { await ctx.reply(`❌ Aucun résultat pour "<b>${query}</b>".`, { parse_mode: "HTML" }); return; }
    const lines = results.map((u) => {
      const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
      return `• ${name} — <code>${u.telegramId}</code>  ${vipRank(u.referralCount)}\n  💰 ${u.balance.toLocaleString("fr-FR")} F · 👥 ${u.referralCount} · ${u.isBanned ? "🚫" : "✅"}`;
    });
    await ctx.reply(
      `🔍 <b>Résultats (${results.length})</b>\n\n${lines.join("\n\n")}\n\n<i>Utilisez /admin_user &lt;ID&gt; pour le profil complet.</i>`,
      { parse_mode: "HTML" }
    );
  });

  // =========================================================================
  // ADMIN REPORT COMMANDS
  // =========================================================================

  bot.command("admin_rapport_quotidien", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply("⏳ <b>Génération du rapport quotidien...</b>", { parse_mode: "HTML" });
    try {
      const report = await generateDailyReport();
      await ctx.reply(report, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "Erreur génération rapport quotidien");
      await ctx.reply("❌ Erreur lors de la génération du rapport.");
    }
  });

  bot.command("admin_rapport_hebdo", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply("⏳ <b>Génération du rapport hebdomadaire...</b>", { parse_mode: "HTML" });
    try {
      const report = await generateWeeklyReport();
      await ctx.reply(report, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "Erreur génération rapport hebdomadaire");
      await ctx.reply("❌ Erreur lors de la génération du rapport.");
    }
  });

  bot.command("admin_rapport_config", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const sub   = parts[1]?.toLowerCase();

    if (!sub) {
      const cfg = await getReportConfig();
      const fmtDate = (d: Date | null) => d ? d.toLocaleString("fr-FR") : "Jamais";
      await ctx.reply(
        `⚙️ <b>Configuration des Rapports</b>\n\n` +
        `🕗 Heure d'envoi (UTC) : <b>${cfg.dailyHour}h00</b>\n` +
        `💵 Seuil alerte retrait : <b>${cfg.largeThreshold.toLocaleString("fr-FR")} F</b>\n\n` +
        `📊 Dernier rapport quotidien : <i>${fmtDate(cfg.lastDaily)}</i>\n` +
        `📈 Dernier rapport hebdo : <i>${fmtDate(cfg.lastWeekly)}</i>\n\n` +
        `<b>Commandes :</b>\n` +
        `• /admin_rapport_config heure <code>8</code> — heure d'envoi (0-23 UTC)\n` +
        `• /admin_rapport_config seuil <code>25000</code> — seuil alerte retrait\n` +
        `• /admin_rapport_quotidien — rapport maintenant\n` +
        `• /admin_rapport_hebdo — rapport hebdo maintenant`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (sub === "heure") {
      const hour = parseInt(parts[2] ?? "", 10);
      if (isNaN(hour) || hour < 0 || hour > 23) { await ctx.reply("❌ Heure invalide (0-23)."); return; }
      await setReportDailyHour(hour);
      await ctx.reply(`✅ Rapports automatiques configurés à <b>${hour}h00 UTC</b> chaque jour.`, { parse_mode: "HTML" });
      return;
    }

    if (sub === "seuil") {
      const amount = parseInt(parts[2] ?? "", 10);
      if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Montant invalide."); return; }
      await setReportLargeThreshold(amount);
      await ctx.reply(`✅ Seuil d'alerte retrait mis à <b>${amount.toLocaleString("fr-FR")} F</b>.`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply("Sous-commandes : heure <h> | seuil <montant>");
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Erreur bot non gérée");
  });

  return bot;
}

// ─── Helpers broadcast ────────────────────────────────────────────────────────
async function showBroadcastPreview(ctx: any, state: BroadcastState): Promise<void> {
  const typeLabel = state.msgType === "text" ? "Texte" : state.msgType === "photo" ? "Photo" : "Vidéo";
  const preview = (state.content ?? "").slice(0, 100) + ((state.content?.length ?? 0) > 100 ? "…" : "");
  await ctx.reply(
    `👁️ <b>Aperçu</b>\n\n<i>${preview || "(média sans légende)"}</i>\n\nType : <b>${typeLabel}</b>\n\nChoisissez les destinataires :`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("👥 Tous les utilisateurs", "bc_target_all")],
        [Markup.button.callback(`✅ Actifs (${ACTIVE_USER_DAYS}j)`, "bc_target_active")],
        [Markup.button.callback("❌ Annuler", "bc_cancel")],
      ]),
    }
  );
}

async function showBroadcastConfirmation(ctx: any, state: BroadcastState): Promise<void> {
  const targets = await getBroadcastTargets(state.target ?? "all");
  const scheduleInfo = state.scheduledAt
    ? `📅 Planifiée : <b>${state.scheduledAt.toLocaleString("fr-FR")}</b>`
    : `📤 Envoi : <b>Immédiat</b>`;
  await ctx.reply(
    `✅ <b>Confirmation</b>\n\nType : <b>${state.msgType}</b>\nCible : <b>${state.target === "all" ? "Tous" : "Actifs"}</b> — <b>${targets.length} destinataires</b>\n${scheduleInfo}\n\n<i>${(state.content ?? "").slice(0, 150)}</i>\n\n⚠️ Action irréversible. Confirmer ?`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirmer l'envoi", "bc_confirm"), Markup.button.callback("❌ Annuler", "bc_cancel")],
      ]),
    }
  );
}

function parseFrDate(input: string): Date | null {
  const match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, d, mo, y, h, mi] = match;
  const date = new Date(`${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}T${h!.padStart(2, "0")}:${mi}:00`);
  return isNaN(date.getTime()) ? null : date;
}
import express from "express";

app.get("/", (req, res) => {
  res.send("Bot Telegram actif ✅");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur web actif sur le port ${PORT}`);
});
node index.js