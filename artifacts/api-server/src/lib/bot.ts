import { Telegraf, Markup } from "telegraf";
import { eq, sql, desc, and, gt, lt, count, ne } from "drizzle-orm";
import { db } from "@workspace/db";
import {
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
  type Broadcast,
} from "@workspace/db";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────
const REFERRAL_REWARD = 800;
const DAILY_BONUS = 200;
const MIN_WITHDRAWAL = 10_000;
const MIN_TASKS_FOR_BONUS = 1;
const DAILY_BONUS_HOURS = 24;
const FRAUD_REFERRAL_WINDOW_MS = 5 * 60 * 1000;
const FRAUD_REFERRAL_MAX = 5;
const BROADCAST_DELAY_MS = 50; // safe rate: ~20 msg/s (Telegram limit: 30/s)
const ACTIVE_USER_DAYS = 30;

// ─── Settings cache ───────────────────────────────────────────────────────────
interface SettingsCache {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  welcomeMessage: string | null;
  refreshedAt: number;
}
let settingsCache: SettingsCache = {
  maintenanceMode: false,
  maintenanceMessage: "🔧 Le bot est en maintenance. Revenez bientôt !",
  welcomeMessage: null,
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
    refreshedAt: Date.now(),
  };
}

async function getSettings(): Promise<SettingsCache> {
  if (Date.now() - settingsCache.refreshedAt > CACHE_TTL_MS) {
    await refreshSettingsCache();
  }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
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
  const channelList = missing.map((ch) => `• ${ch.channelName} (<code>${ch.channelId}</code>)`).join("\n");
  await ctx.reply(
    `🔒 <b>Accès requis</b>\n\nPour utiliser ce bot, rejoignez ${missing.length === 1 ? "ce canal" : "ces canaux"} :\n\n${channelList}\n\nRejoignez-les puis appuyez sur ✅ Vérifier.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...missing.map((ch) => [Markup.button.url(`📢 Rejoindre ${ch.channelName}`, `https://t.me/${ch.channelId.replace("@", "")}`)]),
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
  if (referrer) {
    const timeDiff = Math.abs(referredCreatedAt.getTime() - referrer.createdAt.getTime());
    if (timeDiff < 30_000) return true;
  }
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
    await ctx.reply("❌ Vous n'êtes pas autorisé à utiliser les commandes administrateur.");
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
  settingsCache.refreshedAt = 0; // invalidate cache
}

// ─── Broadcast engine ─────────────────────────────────────────────────────────
async function getBroadcastTargets(filter: "all" | "active"): Promise<string[]> {
  let query = db.select({ telegramId: usersTable.telegramId }).from(usersTable)
    .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)));
  if (filter === "active") {
    const cutoff = new Date(Date.now() - ACTIVE_USER_DAYS * 24 * 60 * 60 * 1000);
    // @ts-ignore — drizzle where chain
    query = db.select({ telegramId: usersTable.telegramId }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff)));
  }
  const rows = await query;
  return rows.map((r) => r.telegramId);
}

async function executeBroadcast(telegram: Telegraf["telegram"], broadcastId: number): Promise<void> {
  const [bc] = await db.select().from(broadcastsTable).where(eq(broadcastsTable.id, broadcastId));
  if (!bc || bc.status !== "scheduled") return;

  const targets = await getBroadcastTargets(bc.targetFilter as "all" | "active");
  await db.update(broadcastsTable).set({
    status: "sending", totalTargets: targets.length, startedAt: new Date(),
  }).where(eq(broadcastsTable.id, broadcastId));

  let sent = 0; let failed = 0; let blocked = 0;

  for (const userId of targets) {
    try {
      if (bc.type === "text") {
        await telegram.sendMessage(userId, bc.content, { parse_mode: "HTML" });
      } else if (bc.type === "photo" && bc.mediaFileId) {
        await telegram.sendPhoto(userId, bc.mediaFileId, { caption: bc.content, parse_mode: "HTML" });
      } else if (bc.type === "video" && bc.mediaFileId) {
        await telegram.sendVideo(userId, bc.mediaFileId, { caption: bc.content, parse_mode: "HTML" });
      }
      sent++;
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("blocked") || msg.includes("deactivated") || msg.includes("chat not found") || msg.includes("Forbidden")) {
        blocked++;
      } else {
        failed++;
      }
    }
    await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
  }

  await db.update(broadcastsTable).set({
    status: "completed", sentCount: sent, failedCount: failed, blockedCount: blocked, completedAt: new Date(),
  }).where(eq(broadcastsTable.id, broadcastId));

  logger.info({ broadcastId, sent, failed, blocked }, "Diffusion terminée");
}

async function processScheduledBroadcasts(telegram: Telegraf["telegram"]): Promise<void> {
  const now = new Date();
  const due = await db.select().from(broadcastsTable)
    .where(and(eq(broadcastsTable.status, "scheduled"), lt(broadcastsTable.scheduledAt, now)));
  for (const bc of due) {
    logger.info({ broadcastId: bc.id }, "Démarrage diffusion planifiée");
    executeBroadcast(telegram, bc.id).catch((err) => logger.error({ err, broadcastId: bc.id }, "Erreur diffusion"));
  }
}

// ─── Bot factory ─────────────────────────────────────────────────────────────
export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  // ─── Global maintenance mode middleware ───────────────────────────────────
  bot.use(async (ctx, next) => {
    const telegramId = String(ctx.from?.id ?? "");
    const isAdminUser = adminIds().includes(telegramId);
    if (isAdminUser) return next();
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      await ctx.reply(settings.maintenanceMessage);
      return;
    }
    return next();
  });

  // ─── Scheduled broadcast processor ───────────────────────────────────────
  setInterval(() => {
    processScheduledBroadcasts(bot.telegram).catch((err) =>
      logger.error({ err }, "Erreur vérification diffusions planifiées")
    );
  }, 60_000);

  // ─── Callbacks ───────────────────────────────────────────────────────────
  bot.action("verify_membership", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? "");
    const missing = await getMissingChannels(ctx.telegram, telegramId);
    if (missing.length === 0) {
      await ctx.reply("✅ Parfait ! Vous êtes maintenant membre de tous les canaux. Bienvenue ! 🎉", mainMenu());
    } else {
      await ctx.reply(`❌ Il vous manque encore :\n${missing.map((ch) => `• ${ch.channelName}`).join("\n")}\n\nRejoignez-les puis vérifiez à nouveau.`);
    }
  });

  // Broadcast inline keyboard callbacks
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
    await ctx.editMessageText(`📢 <b>Nouvelle diffusion — ${msgType === "text" ? "Texte" : msgType === "photo" ? "Photo" : "Vidéo"}</b>\n\n${prompts[msgType]}\n\n/annuler_diffusion pour annuler`, { parse_mode: "HTML" });
  });

  bot.action(/^bc_target_(all|active)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state) return;
    state.target = ctx.match[1] as "all" | "active";
    state.step = "schedule_choice";
    broadcastState.set(adminId, state);
    const count = (await getBroadcastTargets(state.target)).length;
    await ctx.reply(
      `👥 Cible : <b>${state.target === "all" ? "Tous les utilisateurs" : `Actifs (${ACTIVE_USER_DAYS} derniers jours)`}</b>\n📊 Destinataires estimés : <b>${count}</b>\n\nQuand envoyer ?`,
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
    if (!state || !state.target) return;
    state.scheduledAt = undefined;
    state.step = "confirm";
    broadcastState.set(adminId, state);
    await showBroadcastConfirmation(ctx, adminId, state, false);
  });

  bot.action("bc_schedule", async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state) return;
    state.step = "schedule_time";
    broadcastState.set(adminId, state);
    await ctx.reply(
      `⏰ <b>Planifier la diffusion</b>\n\nEntrez la date et l'heure au format :\n<code>JJ/MM/AAAA HH:MM</code>\n\nEx : <code>25/12/2025 14:30</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.action("bc_confirm", async (ctx) => {
    await ctx.answerCbQuery("⏳ Diffusion en cours...");
    const adminId = String(ctx.from?.id ?? "");
    const state = broadcastState.get(adminId);
    if (!state || !state.content || !state.msgType || !state.target) return;
    broadcastState.delete(adminId);

    const [bc] = await db.insert(broadcastsTable).values({
      type: state.msgType,
      content: state.content,
      mediaFileId: state.mediaFileId ?? null,
      status: "scheduled",
      targetFilter: state.target,
      scheduledAt: state.scheduledAt ?? null,
      createdBy: adminId,
    }).returning();

    if (!state.scheduledAt) {
      await ctx.editMessageText(`⏳ <b>Diffusion démarrée !</b>\n🆔 #${bc!.id}\n\nEnvoi en cours... Consultez /admin_diffusions pour les stats.`, { parse_mode: "HTML" });
      executeBroadcast(bot.telegram, bc!.id).catch((err) => logger.error({ err, broadcastId: bc!.id }, "Erreur diffusion"));
    } else {
      await ctx.editMessageText(
        `✅ <b>Diffusion planifiée !</b>\n🆔 #${bc!.id}\n📅 Heure : <b>${state.scheduledAt.toLocaleString("fr-FR")}</b>\n\nConsultez /admin_diffusions pour les détails.`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.action("bc_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    broadcastState.delete(String(ctx.from?.id ?? ""));
    await ctx.editMessageText("❌ Diffusion annulée.");
  });

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
          } else {
            await db.insert(referralsTable).values({
              referrerId: referredByTelegramId, referredId: telegramId, rewardAmount: REFERRAL_REWARD,
            }).onConflictDoNothing();
            await db.update(usersTable)
              .set({ balance: sql`${usersTable.balance} + ${REFERRAL_REWARD}`, referralCount: sql`${usersTable.referralCount} + 1` })
              .where(eq(usersTable.telegramId, referredByTelegramId));
            try {
              await ctx.telegram.sendMessage(referredByTelegramId,
                `🎉 <b>${firstName ?? "Un nouvel utilisateur"}</b> a rejoint via votre lien !\n+<b>${REFERRAL_REWARD} F</b> 💰`,
                { parse_mode: "HTML" });
            } catch { }
          }
        }
      }

      const missing = await getMissingChannels(ctx.telegram, telegramId);
      if (missing.length > 0) {
        const channelList = missing.map((ch) => `• ${ch.channelName}`).join("\n");
        await ctx.reply(
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\nPour accéder au bot, rejoignez ${missing.length === 1 ? "ce canal" : "ces canaux"} :\n\n${channelList}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              ...missing.map((ch) => [Markup.button.url(`📢 Rejoindre ${ch.channelName}`, `https://t.me/${ch.channelId.replace("@", "")}`)]),
              [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
            ]),
          }
        );
      } else {
        const settings = await getSettings();
        const welcomeMsg = settings.welcomeMessage ??
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n🎁 Complétez des tâches et invitez des amis !\n💰 Parrainage = <b>${REFERRAL_REWARD} F</b> | 🎁 Bonus = <b>${DAILY_BONUS} F</b>/jour`;
        const finalMsg = welcomeMsg
          .replace("{prenom}", firstName ?? "ami(e)")
          .replace("{parrainage}", String(REFERRAL_REWARD))
          .replace("{bonus}", String(DAILY_BONUS));
        await ctx.reply(finalMsg + (referredByTelegramId ? "\n\n✨ Vous avez été parrainé(e) !" : ""), { parse_mode: "HTML", ...mainMenu() });
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
      `💰 <b>Mon Solde</b>\n\n💵 Disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n👥 Parrainages : <b>${user.referralCount}</b>\n✅ Tâches : <b>${user.tasksCompletedCount}</b>` +
      ((pw?.c ?? 0) > 0 ? `\n⏳ Retrait en attente : <b>${pw!.c}</b>` : "") +
      `\n\n💡 Retrait minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Mon Lien ─────────────────────────────────────────────────────────────
  bot.hears("🔗 Mon Lien de Parrainage", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    let botUsername = "bot";
    try { const me = await ctx.telegram.getMe(); botUsername = me.username ?? "bot"; } catch { }
    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const refs = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, telegramId));
    await ctx.reply(
      `🔗 <b>Mon Lien de Parrainage</b>\n\nGagnez <b>${REFERRAL_REWARD} F</b> par ami inscrit !\n\n<code>${link}</code>\n\n👥 Parrainages : <b>${refs.length}</b>\n💰 Gains : <b>${(refs.length * REFERRAL_REWARD).toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
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
      return `${done ? "✅" : "🔲"} <b>${t.title}</b> — <b>+${t.rewardAmount} F</b>\n   📝 ${t.description}\n   ${done ? "<i>Terminée</i>" : `➡️ /valider_${t.id}`}`;
    });
    await ctx.reply(
      `📋 <b>Mes Tâches</b>\n\nProgression : <b>${completedIds.size}/${tasks.length}</b>\n\n${lines.join("\n\n")}\n\n💡 Complétez ≥${MIN_TASKS_FOR_BONUS} tâche pour débloquer le bonus.`,
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
      return `${medal} ${name}${u.telegramId === telegramId ? " 👈" : ""}\n   👥 ${u.referralCount} filleuls · 💰 ${u.balance.toLocaleString("fr-FR")} F`;
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
        `🎁 <b>Bonus Quotidien</b>\n\n❌ Complétez au moins <b>${MIN_TASKS_FOR_BONUS} tâche(s)</b> d'abord.\nTâches : <b>${user.tasksCompletedCount}/${MIN_TASKS_FOR_BONUS}</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    const now = new Date();
    if (user.lastDailyBonusAt) {
      const hoursSince = (now.getTime() - user.lastDailyBonusAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < DAILY_BONUS_HOURS) {
        const next = new Date(user.lastDailyBonusAt.getTime() + DAILY_BONUS_HOURS * 3_600_000);
        const diff = next.getTime() - now.getTime();
        const h = Math.floor(diff / 3_600_000);
        const m = Math.floor((diff % 3_600_000) / 60_000);
        await ctx.reply(`🎁 <b>Bonus Quotidien</b>\n\n⏳ Déjà réclamé. Prochain bonus dans : <b>${h}h ${m}min</b>`, { parse_mode: "HTML", ...mainMenu() });
        return;
      }
    }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${DAILY_BONUS}`, lastDailyBonusAt: now })
      .where(eq(usersTable.telegramId, telegramId)).returning();
    await ctx.reply(
      `🎁 <b>Bonus Réclamé !</b>\n\n✅ <b>+${DAILY_BONUS} F</b>\n💰 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>\n\nRevenez demain ⏰`,
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
      await ctx.reply(`💸 <b>Retrait</b>\n\n❌ Solde insuffisant.\n💰 Solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n📊 Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML", ...mainMenu() });
      return;
    }
    const pending = await db.select().from(withdrawalsTable).where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    if (pending.length > 0) { await ctx.reply("⏳ Vous avez déjà un retrait en attente.", mainMenu()); return; }
    convState.set(telegramId, { step: "awaiting_amount" });
    await ctx.reply(
      `💸 <b>Retrait</b>\n\n💰 Solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>\nMinimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n\nCombien souhaitez-vous retirer ?`,
      { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() }
    );
  });

  // ─── Aide ────────────────────────────────────────────────────────────────
  bot.hears("ℹ️ Aide", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const channels = await getActiveChannels();
    const channelLine = channels.length > 0 ? `\n\n<b>📢 Canaux obligatoires :</b>\n${channels.map((c) => `• ${c.channelName}`).join("\n")}` : "";
    await ctx.reply(
      `ℹ️ <b>Comment ça marche ?</b>\n\n💰 <b>Mon Solde</b> — voir vos fonds\n🔗 <b>Mon Lien</b> — parrainage (+${REFERRAL_REWARD} F/ami)\n📋 <b>Mes Tâches</b> — missions à compléter\n🏆 <b>Classement</b> — top parrains\n🎁 <b>Bonus</b> — ${DAILY_BONUS} F/jour\n💸 <b>Retrait</b> — min ${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F${channelLine}`,
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
    if (existing.some((t) => t.taskId === taskId)) { await ctx.reply(`✅ Vous avez déjà complété <b>"${task.title}"</b>.`, { parse_mode: "HTML" }); return; }
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
    if (broadcastState.has(adminId)) {
      broadcastState.delete(adminId);
      await ctx.reply("❌ Diffusion annulée.", mainMenu());
    }
  });

  // ─── Conversation handler ─────────────────────────────────────────────────
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
        if (!parsed) { await ctx.reply("❌ Format invalide. Utilisez : JJ/MM/AAAA HH:MM\nEx : 25/12/2025 14:30"); return; }
        if (parsed <= new Date()) { await ctx.reply("❌ La date doit être dans le futur."); return; }
        bcState.scheduledAt = parsed;
        bcState.step = "confirm";
        broadcastState.set(telegramId, bcState);
        await showBroadcastConfirmation(ctx, telegramId, bcState, true);
        return;
      }

      // Admin settings conversation
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
      if (isNaN(amount) || amount < MIN_WITHDRAWAL) { await ctx.reply(`❌ Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" }); return; }
      const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
      if (!user || amount > user.balance) { await ctx.reply(`❌ Solde insuffisant : <b>${(user?.balance ?? 0).toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" }); convState.delete(telegramId); await ctx.reply("Annulé.", mainMenu()); return; }
      state.step = "awaiting_method"; state.amount = amount;
      convState.set(telegramId, state);
      await ctx.reply("💳 Choisissez votre méthode :", {
        ...Markup.keyboard([["📱 Mobile Money", "🏦 Virement Bancaire"], ["💰 PayPal", "🔐 Crypto (USDT/BTC)"], ["❌ Annuler"]]).resize(),
      });
      return;
    }
    if (state.step === "awaiting_method") {
      if (!["📱 Mobile Money", "🏦 Virement Bancaire", "💰 PayPal", "🔐 Crypto (USDT/BTC)"].includes(text)) { await ctx.reply("❌ Choisissez une option."); return; }
      state.step = "awaiting_details"; state.method = text;
      convState.set(telegramId, state);
      const prompts: Record<string, string> = {
        "📱 Mobile Money": "Votre numéro Mobile Money :",
        "🏦 Virement Bancaire": "IBAN + Nom du titulaire :",
        "💰 PayPal": "Adresse e-mail PayPal :",
        "🔐 Crypto (USDT/BTC)": "Adresse de wallet (précisez réseau ex: TRC20) :",
      };
      await ctx.reply(`📝 ${prompts[text] ?? "Vos coordonnées :"}`, Markup.keyboard([["❌ Annuler"]]).resize());
      return;
    }
    if (state.step === "awaiting_details") {
      if (!state.amount || !state.method) { convState.delete(telegramId); await ctx.reply("❌ Erreur.", mainMenu()); return; }
      const [withdrawal] = await db.insert(withdrawalsTable).values({
        telegramId, amount: state.amount, paymentMethod: state.method, paymentDetails: text, status: "pending",
      }).returning();
      const [updatedUser] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} - ${state.amount}` }).where(eq(usersTable.telegramId, telegramId)).returning();
      const savedAmount = state.amount; const savedMethod = state.method;
      convState.delete(telegramId);
      await ctx.reply(
        `✅ <b>Retrait enregistré !</b>\n\n🆔 #${withdrawal!.id}\n💰 ${savedAmount.toLocaleString("fr-FR")} F\n💳 ${savedMethod}\n⏳ En attente d'approbation\n\n💵 Solde restant : <b>${updatedUser!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      for (const adminId of adminIds()) {
        try {
          const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
          const name = u?.username ? `@${u.username}` : u?.firstName ?? telegramId;
          await ctx.telegram.sendMessage(adminId,
            `💸 <b>Nouveau retrait !</b>\n\n👤 ${name} (${telegramId})\n🆔 #${withdrawal!.id} — ${savedAmount.toLocaleString("fr-FR")} F\n💳 ${savedMethod}\n📝 <code>${text}</code>\n\n✅ /admin_approuver_${withdrawal!.id}\n❌ /admin_rejeter_${withdrawal!.id} <raison>`,
            { parse_mode: "HTML" });
        } catch { }
      }
    }
  });

  // Photo handler for broadcasts
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

  // Video handler for broadcasts
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

  // ─── Admin commands ───────────────────────────────────────────────────────
  bot.command("admin", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply(
      `🔧 <b>Panneau Administrateur</b>\n\n` +
      `📊 /admin_stats — statistiques\n\n` +
      `📢 <b>Diffusions</b>\n/admin_broadcast — nouvelle diffusion\n/admin_diffusions — historique\n\n` +
      `⚙️ <b>Paramètres</b>\n/admin_parametres — paramètres bot\n/admin_bienvenue — message de bienvenue\n/admin_maintenance on/off — mode maintenance\n\n` +
      `👥 <b>Utilisateurs</b>\n/admin_solde /admin_bonus /admin_ban /admin_unban /admin_fraude\n\n` +
      `📋 <b>Tâches</b>\n/admin_tache /admin_taches\n\n` +
      `📢 <b>Canaux</b>\n/admin_canal\n\n` +
      `💸 <b>Retraits</b>\n/admin_retraits /admin_approuver_<id> /admin_rejeter_<id>`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /admin_broadcast ─────────────────────────────────────────────────────
  bot.command("admin_broadcast", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    broadcastState.set(adminId, { step: "type" });
    await ctx.reply(
      `📢 <b>Nouvelle Diffusion</b>\n\nChoisissez le type de message à envoyer :`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📝 Texte", "bc_type_text"), Markup.button.callback("🖼️ Photo", "bc_type_photo"), Markup.button.callback("🎥 Vidéo", "bc_type_video")],
          [Markup.button.callback("❌ Annuler", "bc_cancel")],
        ]),
      }
    );
  });

  // ─── /admin_diffusions ────────────────────────────────────────────────────
  bot.command("admin_diffusions", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const broadcasts = await db.select().from(broadcastsTable).orderBy(desc(broadcastsTable.createdAt)).limit(10);
    if (broadcasts.length === 0) { await ctx.reply("📢 Aucune diffusion enregistrée."); return; }
    const statusIcon: Record<string, string> = { scheduled: "⏰", sending: "📡", completed: "✅", failed: "❌", cancelled: "🚫" };
    const lines = broadcasts.map((b) => {
      const icon = statusIcon[b.status] ?? "❓";
      const date = b.scheduledAt ?? b.createdAt;
      const stats = b.status === "completed"
        ? `📤 ${b.sentCount} envoyés · ❌ ${b.failedCount} échoués · 🚫 ${b.blockedCount} bloqués`
        : `🎯 ${b.totalTargets} cibles`;
      return `${icon} <b>#${b.id}</b> — ${b.type} — ${date.toLocaleDateString("fr-FR")}\n   ${stats}\n   <i>${b.content.slice(0, 50)}${b.content.length > 50 ? "…" : ""}</i>`;
    });
    await ctx.reply(`📢 <b>Historique des Diffusions</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // ─── /admin_parametres ───────────────────────────────────────────────────
  bot.command("admin_parametres", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const maintenanceMode = (await getSetting(SETTING_KEYS.MAINTENANCE_MODE)) === "true";
    const welcomeMsg = await getSetting(SETTING_KEYS.WELCOME_MESSAGE);
    await ctx.reply(
      `⚙️ <b>Paramètres du Bot</b>\n\n` +
      `🔧 Maintenance : <b>${maintenanceMode ? "✅ Activée" : "❌ Désactivée"}</b>\n` +
      `👋 Message de bienvenue : <b>${welcomeMsg ? "Personnalisé" : "Par défaut"}</b>\n\n` +
      `Commandes :\n` +
      `/admin_bienvenue — éditer le message de bienvenue\n` +
      `/admin_maintenance on — activer la maintenance\n` +
      `/admin_maintenance off — désactiver la maintenance\n` +
      `/admin_maintenance_msg — éditer le message de maintenance`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /admin_bienvenue ─────────────────────────────────────────────────────
  bot.command("admin_bienvenue", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const current = await getSetting(SETTING_KEYS.WELCOME_MESSAGE);
    adminSettingState.set(String(ctx.from.id), { step: "welcome_content" });
    await ctx.reply(
      `👋 <b>Message de Bienvenue</b>\n\n` +
      (current ? `Message actuel :\n<i>${current}</i>\n\n` : "Aucun message personnalisé (défaut utilisé).\n\n") +
      `Variables disponibles :\n• <code>{prenom}</code> — prénom de l'utilisateur\n• <code>{parrainage}</code> — récompense parrainage\n• <code>{bonus}</code> — bonus quotidien\n\n` +
      `Rédigez le nouveau message (HTML supporté) :\n/annuler_diffusion pour annuler`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /admin_maintenance ──────────────────────────────────────────────────
  bot.command("admin_maintenance", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    const arg = ctx.message.text.split(" ")[1]?.toLowerCase();
    if (arg === "on") {
      await setSetting(SETTING_KEYS.MAINTENANCE_MODE, "true", adminId);
      await ctx.reply("🔧 Mode maintenance <b>activé</b>.\nLes utilisateurs verront le message de maintenance.", { parse_mode: "HTML" });
    } else if (arg === "off") {
      await setSetting(SETTING_KEYS.MAINTENANCE_MODE, "false", adminId);
      await ctx.reply("✅ Mode maintenance <b>désactivé</b>. Le bot est de nouveau accessible.", { parse_mode: "HTML" });
    } else {
      const current = (await getSetting(SETTING_KEYS.MAINTENANCE_MODE)) === "true";
      await ctx.reply(`🔧 Maintenance actuellement : <b>${current ? "ON" : "OFF"}</b>\n\nUsage : /admin_maintenance on — activer\n/admin_maintenance off — désactiver`, { parse_mode: "HTML" });
    }
  });

  // ─── /admin_maintenance_msg ──────────────────────────────────────────────
  bot.command("admin_maintenance_msg", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    adminSettingState.set(String(ctx.from.id), { step: "maintenance_message" });
    await ctx.reply("🔧 Rédigez le message affiché aux utilisateurs en mode maintenance :");
  });

  // ─── Admin : stats ────────────────────────────────────────────────────────
  bot.command("admin_stats", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const [uc] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
    const [rc] = await db.select({ c: sql<number>`count(*)::int` }).from(referralsTable);
    const [pts] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(usersTable);
    const [tc] = await db.select({ c: sql<number>`count(*)::int` }).from(tasksTable).where(eq(tasksTable.isActive, true));
    const [pw] = await db.select({ c: sql<number>`count(*)::int` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending"));
    const [aw] = await db.select({ s: sql<number>`coalesce(sum(amount),0)::int` }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "approved"));
    const [fc] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.flaggedForFraud, true));
    const [bc] = await db.select({ c: sql<number>`count(*)::int` }).from(broadcastsTable).where(eq(broadcastsTable.status, "completed"));
    const cutoff = new Date(Date.now() - ACTIVE_USER_DAYS * 24 * 3_600_000);
    const [active] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false), gt(usersTable.createdAt, cutoff)));
    await ctx.reply(
      `📊 <b>Statistiques Communautaires</b>\n\n` +
      `👥 Utilisateurs total : <b>${uc?.c ?? 0}</b>\n` +
      `📅 Actifs (${ACTIVE_USER_DAYS}j) : <b>${active?.c ?? 0}</b>\n` +
      `🔗 Parrainages : <b>${rc?.c ?? 0}</b>\n` +
      `💰 Fonds distribués : <b>${(pts?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `📋 Tâches actives : <b>${tc?.c ?? 0}</b>\n` +
      `⏳ Retraits en attente : <b>${pw?.c ?? 0}</b>\n` +
      `✅ Total retiré : <b>${(aw?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `🚨 Comptes frauduleux : <b>${fc?.c ?? 0}</b>\n` +
      `📢 Diffusions envoyées : <b>${bc?.c ?? 0}</b>`,
      { parse_mode: "HTML" }
    );
  });

  // ─── Admin : /admin_tache (with notification) ────────────────────────────
  bot.command("admin_tache", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const text = ctx.message.text.replace("/admin_tache", "").trim();
    const parts = text.split("|");
    const firstPart = (parts[0] ?? "").trim().split(" ");
    const reward = parseInt(firstPart[0] ?? "", 10);
    const title = firstPart.slice(1).join(" ").trim();
    const description = (parts[1] ?? "").trim();
    if (isNaN(reward) || !title || !description) {
      await ctx.reply("Usage : /admin_tache <récompense> <titre> | <description>");
      return;
    }
    const [task] = await db.insert(tasksTable).values({ title, description, rewardAmount: reward, isActive: true }).returning();
    await ctx.reply(
      `✅ Tâche créée !\n🆔 ID : <b>${task!.id}</b>\n📝 <b>${title}</b>\n💰 +${reward} F\n\n🔔 Notifier tous les utilisateurs ?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Oui, notifier", `notify_task_${task!.id}`), Markup.button.callback("❌ Non", "notify_skip")],
        ]),
      }
    );
  });

  bot.action(/^notify_task_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Notification en cours...");
    const taskId = parseInt(ctx.match[1] ?? "", 10);
    if (isNaN(taskId)) return;
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) return;
    await ctx.editMessageText(`⏳ Envoi des notifications pour la tâche <b>"${task.title}"</b>...`, { parse_mode: "HTML" });

    const targets = await getBroadcastTargets("all");
    let sent = 0;
    for (const userId of targets) {
      try {
        await ctx.telegram.sendMessage(userId,
          `📋 <b>Nouvelle Tâche Disponible !</b>\n\n✨ <b>${task.title}</b>\n📝 ${task.description}\n💰 Récompense : <b>+${task.rewardAmount} F</b>\n\n➡️ /valider_${task.id}`,
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

  bot.command("admin_taches", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    if (tasks.length === 0) { await ctx.reply("Aucune tâche."); return; }
    const lines = tasks.map((t) => `${t.isActive ? "✅" : "❌"} [${t.id}] <b>${t.title}</b> — +${t.rewardAmount} F\n   ${t.description}`);
    await ctx.reply(`📋 <b>Toutes les Tâches</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // ─── Admin : utilisateurs ─────────────────────────────────────────────────
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
    await ctx.reply(`✅ Bonus <b>+${amount.toLocaleString("fr-FR")} F</b> attribué et utilisateur notifié.`, { parse_mode: "HTML" });
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
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Introuvable."); return; }
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

  // ─── Admin : canaux ───────────────────────────────────────────────────────
  bot.command("admin_canal", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    const text = ctx.message.text.replace("/admin_canal", "").trim();
    const parts = text.split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? "";

    if (!sub || sub === "liste") {
      const channels = await db.select().from(requiredChannelsTable).orderBy(requiredChannelsTable.id);
      if (channels.length === 0) {
        await ctx.reply("📢 Aucun canal configuré.\n\nAjouter : /admin_canal ajouter @canal Nom"); return;
      }
      const lines = channels.map((c) => `${c.isActive ? "✅" : "❌"} [${c.id}] <b>${c.channelName}</b> — <code>${c.channelId}</code>`);
      await ctx.reply(`📢 <b>Canaux (${channels.length})</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" }); return;
    }
    if (sub === "ajouter") {
      const channelId = parts[1]; const channelName = parts.slice(2).join(" ").trim();
      if (!channelId || !channelName) { await ctx.reply("Usage : /admin_canal ajouter @canal Nom du Canal"); return; }
      const normalizedId = channelId.startsWith("@") ? channelId : `@${channelId}`;
      try { await ctx.telegram.getChat(normalizedId); } catch {
        await ctx.reply(`❌ Canal introuvable : <code>${normalizedId}</code>`, { parse_mode: "HTML" }); return;
      }
      const existing = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.channelId, normalizedId));
      if (existing.length > 0) {
        if (!existing[0]!.isActive) {
          await db.update(requiredChannelsTable).set({ isActive: true, channelName }).where(eq(requiredChannelsTable.channelId, normalizedId));
          await ctx.reply(`✅ Canal <b>${channelName}</b> réactivé !`, { parse_mode: "HTML" });
        } else { await ctx.reply(`⚠️ Canal déjà configuré.`); }
        return;
      }
      const [ch] = await db.insert(requiredChannelsTable).values({ channelId: normalizedId, channelName, addedBy: adminId, isActive: true }).returning();
      await ctx.reply(`✅ Canal <b>${channelName}</b> ajouté (ID: ${ch!.id}).`, { parse_mode: "HTML" }); return;
    }
    if (sub === "supprimer") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal supprimer <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Canal introuvable."); return; }
      await db.delete(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`🗑️ Canal <b>${ch.channelName}</b> supprimé.`, { parse_mode: "HTML" }); return;
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
    await ctx.reply("📢 Sous-commandes : liste | ajouter @canal Nom | supprimer <id> | desactiver <id> | activer <id>");
  });

  // ─── Admin : retraits ────────────────────────────────────────────────────
  bot.command("admin_retraits", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const pending = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending")).orderBy(withdrawalsTable.requestedAt).limit(20);
    if (pending.length === 0) { await ctx.reply("✅ Aucun retrait en attente."); return; }
    for (const w of pending) {
      const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, w.telegramId));
      const name = u?.username ? `@${u.username}` : u?.firstName ?? w.telegramId;
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
    await db.update(withdrawalsTable).set({ status: "approved", processedAt: new Date() }).where(eq(withdrawalsTable.id, wId));
    try {
      await ctx.telegram.sendMessage(w.telegramId, `✅ <b>Retrait #${w.id} approuvé !</b>\n💰 ${w.amount.toLocaleString("fr-FR")} F via ${w.paymentMethod}\n🎉 Traitement en cours.`, { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Retrait #${wId} approuvé.`);
  });

  bot.hears(/^\/admin_rejeter_(\d+)(?:\s+(.+))?$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const wId = parseInt(ctx.match[1] ?? "", 10);
    const reason = ctx.match[2]?.trim() ?? "Aucune raison précisée";
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, wId));
    if (!w || w.status !== "pending") { await ctx.reply("❌ Introuvable ou déjà traité."); return; }
    await db.update(withdrawalsTable).set({ status: "rejected", processedAt: new Date(), adminNote: reason }).where(eq(withdrawalsTable.id, wId));
    const [restored] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${w.amount}` }).where(eq(usersTable.telegramId, w.telegramId)).returning();
    try {
      await ctx.telegram.sendMessage(w.telegramId, `❌ <b>Retrait #${w.id} refusé</b>\n📋 Raison : <i>${reason}</i>\n💵 Solde recrédité : <b>${restored!.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`❌ Retrait #${wId} refusé. Solde recrédité.`);
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Erreur bot non gérée");
  });

  return bot;
}

// ─── Broadcast helper functions ──────────────────────────────────────────────
async function showBroadcastPreview(ctx: any, state: BroadcastState): Promise<void> {
  const typeLabel = state.msgType === "text" ? "Texte" : state.msgType === "photo" ? "Photo" : "Vidéo";
  const preview = (state.content ?? "").slice(0, 100) + ((state.content?.length ?? 0) > 100 ? "…" : "");
  await ctx.reply(
    `👁️ <b>Aperçu du message</b>\n\n<i>${preview}</i>\n\n📊 Type : <b>${typeLabel}</b>\n\nChoisissez les destinataires :`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("👥 Tous les utilisateurs", "bc_target_all")],
        [Markup.button.callback(`✅ Actifs (${ACTIVE_USER_DAYS} derniers jours)`, "bc_target_active")],
        [Markup.button.callback("❌ Annuler", "bc_cancel")],
      ]),
    }
  );
}

async function showBroadcastConfirmation(ctx: any, adminId: string, state: BroadcastState, scheduled: boolean): Promise<void> {
  const targets = await getBroadcastTargets(state.target ?? "all");
  const scheduleInfo = state.scheduledAt
    ? `📅 Planifiée : <b>${state.scheduledAt.toLocaleString("fr-FR")}</b>`
    : `📤 Envoi : <b>Immédiat</b>`;
  await ctx.reply(
    `✅ <b>Confirmation de diffusion</b>\n\n` +
    `📊 Type : <b>${state.msgType}</b>\n` +
    `👥 Cible : <b>${state.target === "all" ? "Tous" : "Actifs"}</b> — <b>${targets.length} destinataires</b>\n` +
    `${scheduleInfo}\n\n` +
    `<i>Aperçu :</i>\n${(state.content ?? "").slice(0, 200)}\n\n` +
    `⚠️ Cette action est irréversible. Confirmer ?`,
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
