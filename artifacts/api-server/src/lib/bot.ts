import { Telegraf, Markup } from "telegraf";
import { eq, sql, desc, and, gt, count } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  referralsTable,
  tasksTable,
  userTasksTable,
  withdrawalsTable,
  requiredChannelsTable,
  type RequiredChannel,
} from "@workspace/db";
import { logger } from "./logger";

const REFERRAL_REWARD = 800;
const DAILY_BONUS = 200;
const MIN_WITHDRAWAL = 10_000;
const MIN_TASKS_FOR_BONUS = 1;
const DAILY_BONUS_HOURS = 24;
const FRAUD_REFERRAL_WINDOW_MS = 5 * 60 * 1000;
const FRAUD_REFERRAL_MAX = 5;

type ConvStep = "awaiting_amount" | "awaiting_method" | "awaiting_details";
interface ConvState {
  step: ConvStep;
  amount?: number;
  method?: string;
}
const convState = new Map<string, ConvState>();

function adminIds(): string[] {
  return (process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function getActiveChannels(): Promise<RequiredChannel[]> {
  const fromDb = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.isActive, true));
  if (fromDb.length > 0) return fromDb;
  const envChannel = process.env["REQUIRED_CHANNEL"];
  if (envChannel) {
    return [{
      id: 0,
      channelId: envChannel,
      channelName: envChannel,
      addedBy: "env",
      isActive: true,
      createdAt: new Date(),
    }];
  }
  return [];
}

async function getMissingChannels(telegram: Telegraf["telegram"], userId: string): Promise<RequiredChannel[]> {
  const channels = await getActiveChannels();
  if (channels.length === 0) return [];
  const missing: RequiredChannel[] = [];
  for (const ch of channels) {
    try {
      const member = await telegram.getChatMember(ch.channelId, parseInt(userId, 10));
      if (!["member", "administrator", "creator"].includes(member.status)) {
        missing.push(ch);
      }
    } catch {
      missing.push(ch);
    }
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
    `🔒 <b>Accès requis</b>\n\n` +
    `Pour utiliser ce bot, vous devez rejoindre ${missing.length === 1 ? "ce canal" : "ces canaux"} :\n\n` +
    `${channelList}\n\n` +
    `Rejoignez-les puis appuyez sur ✅ Vérifier.`,
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
  if (!user) {
    await ctx.reply("❌ Compte introuvable. Veuillez taper /start pour vous inscrire.");
    return null;
  }
  if (user.isBanned) {
    await ctx.reply("🚫 Votre compte a été suspendu. Contactez l'administrateur.");
    return null;
  }
  return user;
}

async function detectFraud(referrerId: string, referredCreatedAt: Date): Promise<boolean> {
  const windowStart = new Date(Date.now() - FRAUD_REFERRAL_WINDOW_MS);
  const [recent] = await db.select({ c: count() }).from(referralsTable).where(
    and(eq(referralsTable.referrerId, referrerId), gt(referralsTable.createdAt, windowStart))
  );
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
  const ids = adminIds();
  const tid = String(ctx.from?.id ?? "");
  if (!ids.includes(tid)) {
    await ctx.reply("❌ Vous n'êtes pas autorisé à utiliser les commandes administrateur.");
    return false;
  }
  return true;
}

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  // ─── Verify membership callback ───────────────────────────────────────────
  bot.action("verify_membership", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? "");
    const missing = await getMissingChannels(ctx.telegram, telegramId);
    if (missing.length === 0) {
      await ctx.reply("✅ Parfait ! Vous êtes maintenant membre de tous les canaux. Bienvenue ! 🎉", mainMenu());
    } else {
      const list = missing.map((ch) => `• ${ch.channelName}`).join("\n");
      await ctx.reply(
        `❌ Il vous manque encore ${missing.length === 1 ? "ce canal" : "ces canaux"} :\n\n${list}\n\nRejoignez-les puis vérifiez à nouveau.`
      );
    }
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
            logger.warn({ referrerId: referredByTelegramId, referredId: telegramId }, "Fraude détectée — parrainage bloqué");
          } else {
            await db.insert(referralsTable).values({
              referrerId: referredByTelegramId, referredId: telegramId, rewardAmount: REFERRAL_REWARD,
            }).onConflictDoNothing();
            await db.update(usersTable)
              .set({ balance: sql`${usersTable.balance} + ${REFERRAL_REWARD}`, referralCount: sql`${usersTable.referralCount} + 1` })
              .where(eq(usersTable.telegramId, referredByTelegramId));
            try {
              await ctx.telegram.sendMessage(referredByTelegramId,
                `🎉 <b>${firstName ?? "Un nouvel utilisateur"}</b> a rejoint via votre lien !\n` +
                `Vous avez gagné <b>+${REFERRAL_REWARD} F</b> 💰`,
                { parse_mode: "HTML" });
            } catch { logger.warn({ referrerId: referredByTelegramId }, "Impossible de notifier le parrain"); }
          }
        }
      }

      const missing = await getMissingChannels(ctx.telegram, telegramId);
      if (missing.length > 0) {
        const channelList = missing.map((ch) => `• ${ch.channelName}`).join("\n");
        await ctx.reply(
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n` +
          `Pour accéder au bot, rejoignez ${missing.length === 1 ? "ce canal" : "ces canaux"} :\n\n${channelList}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              ...missing.map((ch) => [Markup.button.url(`📢 Rejoindre ${ch.channelName}`, `https://t.me/${ch.channelId.replace("@", "")}`)]),
              [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
            ]),
          }
        );
      } else {
        const msg = referredByTelegramId
          ? `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> ! Vous avez été parrainé(e).\n\n`
          : `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n`;
        await ctx.reply(
          msg +
          `🎁 Complétez des tâches et invitez des amis pour gagner des fonds !\n` +
          `💰 Parrainage = <b>${REFERRAL_REWARD} F</b> | 🎁 Bonus quotidien = <b>${DAILY_BONUS} F</b>`,
          { parse_mode: "HTML", ...mainMenu() }
        );
      }
    } else {
      await db.update(usersTable).set({ username, firstName, lastName }).where(eq(usersTable.telegramId, telegramId));
      if (!(await requireChannels(ctx))) return;
      await ctx.reply(
        `🔄 Bon retour, <b>${firstName ?? "ami(e)"}</b> ! 👋\n\nQue souhaitez-vous faire ?`,
        { parse_mode: "HTML", ...mainMenu() }
      );
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
      `💵 Solde disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n` +
      `👥 Parrainages : <b>${user.referralCount}</b>\n` +
      `✅ Tâches complétées : <b>${user.tasksCompletedCount}</b>\n` +
      ((pw?.c ?? 0) > 0 ? `⏳ Retrait en attente : <b>${pw!.c}</b>\n` : "") +
      `\n💡 Retrait minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  // ─── Mon Lien de Parrainage ───────────────────────────────────────────────
  bot.hears("🔗 Mon Lien de Parrainage", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    let botUsername = "bot";
    try { const me = await ctx.telegram.getMe(); botUsername = me.username ?? "bot"; } catch { }
    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const referrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, telegramId));
    await ctx.reply(
      `🔗 <b>Mon Lien de Parrainage</b>\n\n` +
      `Partagez ce lien et gagnez <b>${REFERRAL_REWARD} F</b> pour chaque ami inscrit !\n\n` +
      `<code>${link}</code>\n\n` +
      `👥 Parrainages effectués : <b>${referrals.length}</b>\n` +
      `💰 Gains parrainage : <b>${(referrals.length * REFERRAL_REWARD).toLocaleString("fr-FR")} F</b>`,
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
    if (tasks.length === 0) { await ctx.reply("📋 Aucune tâche disponible pour le moment.", mainMenu()); return; }
    const lines = tasks.map((t) => {
      const done = completedIds.has(t.id);
      return `${done ? "✅" : "🔲"} <b>${t.title}</b> — <b>+${t.rewardAmount} F</b>\n   📝 ${t.description}\n   ${done ? "<i>Terminée</i>" : `➡️ /valider_${t.id}`}`;
    });
    await ctx.reply(
      `📋 <b>Mes Tâches</b>\n\n` +
      `Progression : <b>${completedIds.size}/${tasks.length}</b>\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `💡 Complétez au moins <b>${MIN_TASKS_FOR_BONUS}</b> tâche(s) pour débloquer le bonus quotidien.`,
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
      .orderBy(desc(usersTable.referralCount), desc(usersTable.balance))
      .limit(10);
    if (top.length === 0) { await ctx.reply("🏆 Aucun utilisateur au classement.", mainMenu()); return; }
    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((u, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = u.username ? `@${u.username}` : (u.firstName ?? "Utilisateur");
      const you = u.telegramId === telegramId ? " 👈 <i>vous</i>" : "";
      return `${medal} ${name}${you}\n   👥 ${u.referralCount} filleuls · 💰 ${u.balance.toLocaleString("fr-FR")} F`;
    });
    await ctx.reply(`🏆 <b>Classement — Top Parrains</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...mainMenu() });
  });

  // ─── Bonus Quotidien ──────────────────────────────────────────────────────
  bot.hears("🎁 Bonus Quotidien", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    if (user.tasksCompletedCount < MIN_TASKS_FOR_BONUS) {
      await ctx.reply(
        `🎁 <b>Bonus Quotidien</b>\n\n❌ Complétez au moins <b>${MIN_TASKS_FOR_BONUS} tâche(s)</b> pour débloquer ce bonus.\n\n` +
        `Tâches complétées : <b>${user.tasksCompletedCount}/${MIN_TASKS_FOR_BONUS}</b>\n\nAllez dans 📋 Mes Tâches !`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    const now = new Date();
    if (user.lastDailyBonusAt) {
      const hoursSince = (now.getTime() - user.lastDailyBonusAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < DAILY_BONUS_HOURS) {
        const next = new Date(user.lastDailyBonusAt.getTime() + DAILY_BONUS_HOURS * 60 * 60 * 1000);
        const diff = next.getTime() - now.getTime();
        const h = Math.floor(diff / (1000 * 60 * 60));
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        await ctx.reply(
          `🎁 <b>Bonus Quotidien</b>\n\n⏳ Déjà réclamé aujourd'hui.\n\nProchain bonus dans : <b>${h}h ${m}min</b>\n💰 Solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>`,
          { parse_mode: "HTML", ...mainMenu() }
        );
        return;
      }
    }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${DAILY_BONUS}`, lastDailyBonusAt: now })
      .where(eq(usersTable.telegramId, telegramId)).returning();
    await ctx.reply(
      `🎁 <b>Bonus Quotidien Réclamé !</b>\n\n✅ <b>+${DAILY_BONUS} F</b> ajoutés !\n💰 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>\n\nRevenez demain ⏰`,
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
        `💸 <b>Retrait</b>\n\n❌ Solde insuffisant.\n\n💰 Votre solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n📊 Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    const pending = await db.select().from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    if (pending.length > 0) {
      await ctx.reply(
        `💸 <b>Retrait</b>\n\n⏳ Vous avez déjà un retrait en attente d'approbation.\nAttendez la décision de l'administrateur.`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }
    convState.set(telegramId, { step: "awaiting_amount" });
    await ctx.reply(
      `💸 <b>Demande de Retrait</b>\n\n💰 Solde disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n📊 Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n\n💡 Combien souhaitez-vous retirer ?`,
      { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() }
    );
  });

  // ─── Aide ────────────────────────────────────────────────────────────────
  bot.hears("ℹ️ Aide", async (ctx) => {
    if (!(await requireChannels(ctx))) return;
    const channels = await getActiveChannels();
    const channelLine = channels.length > 0
      ? `\n\n<b>📢 Canaux obligatoires :</b>\n${channels.map((c) => `• ${c.channelName}`).join("\n")}`
      : "";
    await ctx.reply(
      `ℹ️ <b>Comment ça marche ?</b>\n\n` +
      `💰 <b>Mon Solde</b> — voir vos fonds et statistiques\n` +
      `🔗 <b>Mon Lien</b> — partagez pour gagner <b>${REFERRAL_REWARD} F</b>/ami\n` +
      `📋 <b>Mes Tâches</b> — complétez des missions\n` +
      `🏆 <b>Classement</b> — top parrains\n` +
      `🎁 <b>Bonus Quotidien</b> — <b>${DAILY_BONUS} F</b>/jour\n` +
      `💸 <b>Retrait</b> — min <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>, approbation admin\n` +
      `${channelLine}\n\n` +
      `<b>🛡️ Anti-fraude :</b> Faux parrainages détectés et sanctionnés automatiquement.`,
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
    if (isNaN(taskId)) { await ctx.reply("❌ Identifiant de tâche invalide."); return; }
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task || !task.isActive) { await ctx.reply("❌ Cette tâche n'existe pas ou n'est plus active."); return; }
    const existing = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    if (existing.some((t) => t.taskId === taskId)) {
      await ctx.reply(`✅ Vous avez déjà complété <b>"${task.title}"</b>.`, { parse_mode: "HTML" });
      return;
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

  // ─── Conversation : retrait ───────────────────────────────────────────────
  bot.on("text", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state) return;
    const text = ctx.message.text.trim();

    if (state.step === "awaiting_amount") {
      const amount = parseInt(text.replace(/[\s\u00a0]/g, ""), 10);
      if (isNaN(amount) || amount < MIN_WITHDRAWAL) {
        await ctx.reply(`❌ Montant invalide. Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
        return;
      }
      const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
      if (!user || amount > user.balance) {
        await ctx.reply(`❌ Solde insuffisant. Votre solde : <b>${(user?.balance ?? 0).toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" });
        convState.delete(telegramId);
        await ctx.reply("Retrait annulé.", mainMenu());
        return;
      }
      state.step = "awaiting_method";
      state.amount = amount;
      convState.set(telegramId, state);
      await ctx.reply(
        `💳 <b>Méthode de paiement</b>\n\nChoisissez votre méthode :`,
        { parse_mode: "HTML", ...Markup.keyboard([["📱 Mobile Money", "🏦 Virement Bancaire"], ["💰 PayPal", "🔐 Crypto (USDT/BTC)"], ["❌ Annuler"]]).resize() }
      );
      return;
    }

    if (state.step === "awaiting_method") {
      const valid = ["📱 Mobile Money", "🏦 Virement Bancaire", "💰 PayPal", "🔐 Crypto (USDT/BTC)"];
      if (!valid.includes(text)) { await ctx.reply("❌ Choisissez une méthode parmi les options proposées."); return; }
      state.step = "awaiting_details";
      state.method = text;
      convState.set(telegramId, state);
      const prompts: Record<string, string> = {
        "📱 Mobile Money": "Entrez votre numéro de téléphone Mobile Money :",
        "🏦 Virement Bancaire": "Entrez vos coordonnées bancaires (IBAN + Nom du titulaire) :",
        "💰 PayPal": "Entrez votre adresse e-mail PayPal :",
        "🔐 Crypto (USDT/BTC)": "Entrez votre adresse de wallet (précisez le réseau, ex: TRC20) :",
      };
      await ctx.reply(`📝 <b>Coordonnées</b>\n\n${prompts[text] ?? "Entrez vos coordonnées :"}`, { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() });
      return;
    }

    if (state.step === "awaiting_details") {
      if (!state.amount || !state.method) { convState.delete(telegramId); await ctx.reply("❌ Erreur. Recommencez.", mainMenu()); return; }
      const [withdrawal] = await db.insert(withdrawalsTable).values({
        telegramId, amount: state.amount, paymentMethod: state.method, paymentDetails: text, status: "pending",
      }).returning();
      const [updatedUser] = await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${state.amount}` })
        .where(eq(usersTable.telegramId, telegramId)).returning();
      const savedAmount = state.amount;
      const savedMethod = state.method;
      convState.delete(telegramId);
      await ctx.reply(
        `✅ <b>Demande de retrait enregistrée !</b>\n\n🆔 Référence : <b>#${withdrawal!.id}</b>\n💰 Montant : <b>${savedAmount.toLocaleString("fr-FR")} F</b>\n💳 Méthode : <b>${savedMethod}</b>\n📋 Statut : ⏳ En attente\n\n💵 Solde restant : <b>${updatedUser!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      for (const adminId of adminIds()) {
        try {
          const [u] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
          const name = u?.username ? `@${u.username}` : u?.firstName ?? telegramId;
          await ctx.telegram.sendMessage(adminId,
            `💸 <b>Nouvelle demande de retrait !</b>\n\n👤 ${name} (${telegramId})\n🆔 Retrait #${withdrawal!.id}\n💰 ${savedAmount.toLocaleString("fr-FR")} F\n💳 ${savedMethod}\n📝 <code>${text}</code>\n\n✅ /admin_approuver_${withdrawal!.id}\n❌ /admin_rejeter_${withdrawal!.id} <raison>`,
            { parse_mode: "HTML" });
        } catch { }
      }
      return;
    }
  });

  // ─── Admin : panel principal ──────────────────────────────────────────────
  bot.command("admin", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply(
      `🔧 <b>Panneau Administrateur</b>\n\n` +
      `📊 /admin_stats\n\n` +
      `👥 <b>Utilisateurs</b>\n` +
      `/admin_solde <id> <montant>\n/admin_bonus <id> <montant>\n/admin_ban <id>\n/admin_unban <id>\n/admin_fraude\n\n` +
      `📋 <b>Tâches</b>\n` +
      `/admin_tache <récompense> <titre> | <desc>\n/admin_taches\n\n` +
      `📢 <b>Canaux obligatoires</b>\n` +
      `/admin_canal liste\n/admin_canal ajouter @canal Nom\n/admin_canal supprimer <id>\n/admin_canal activer <id>\n/admin_canal desactiver <id>\n\n` +
      `💸 <b>Retraits</b>\n` +
      `/admin_retraits\n/admin_approuver_<id>\n/admin_rejeter_<id> <raison>`,
      { parse_mode: "HTML" }
    );
  });

  // ─── Admin : /admin_canal ─────────────────────────────────────────────────
  bot.command("admin_canal", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const adminId = String(ctx.from.id);
    const text = ctx.message.text.replace("/admin_canal", "").trim();
    const parts = text.split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? "";

    if (!sub || sub === "liste") {
      const channels = await db.select().from(requiredChannelsTable).orderBy(requiredChannelsTable.id);
      if (channels.length === 0) {
        await ctx.reply(
          `📢 <b>Canaux obligatoires</b>\n\nAucun canal configuré.\n\n` +
          `Pour ajouter : /admin_canal ajouter @canal Nom du Canal`,
          { parse_mode: "HTML" }
        );
        return;
      }
      const lines = channels.map((c) =>
        `${c.isActive ? "✅" : "❌"} [${c.id}] <b>${c.channelName}</b>\n   <code>${c.channelId}</code>`
      );
      await ctx.reply(
        `📢 <b>Canaux obligatoires (${channels.length})</b>\n\n${lines.join("\n\n")}\n\n` +
        `Pour ajouter : /admin_canal ajouter @canal Nom\n` +
        `Pour désactiver : /admin_canal desactiver <id>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (sub === "ajouter") {
      const channelId = parts[1];
      const channelName = parts.slice(2).join(" ").trim();
      if (!channelId || !channelName) {
        await ctx.reply("Usage : /admin_canal ajouter @canal Nom du Canal\nEx : /admin_canal ajouter @moncanal Mon Canal Officiel");
        return;
      }
      const normalizedId = channelId.startsWith("@") ? channelId : `@${channelId}`;
      try {
        await ctx.telegram.getChat(normalizedId);
      } catch {
        await ctx.reply(`❌ Canal introuvable : <code>${normalizedId}</code>\nVérifiez que le bot est admin du canal.`, { parse_mode: "HTML" });
        return;
      }
      const existing = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.channelId, normalizedId));
      if (existing.length > 0) {
        if (!existing[0]!.isActive) {
          await db.update(requiredChannelsTable).set({ isActive: true, channelName }).where(eq(requiredChannelsTable.channelId, normalizedId));
          await ctx.reply(`✅ Canal <b>${channelName}</b> réactivé avec succès !`, { parse_mode: "HTML" });
        } else {
          await ctx.reply(`⚠️ Ce canal est déjà configuré : <b>${existing[0]!.channelName}</b>`, { parse_mode: "HTML" });
        }
        return;
      }
      const [ch] = await db.insert(requiredChannelsTable).values({
        channelId: normalizedId, channelName, addedBy: adminId, isActive: true,
      }).returning();
      await ctx.reply(
        `✅ <b>Canal ajouté !</b>\n\n🆔 ID : ${ch!.id}\n📢 Canal : <b>${channelName}</b> (<code>${normalizedId}</code>)\n\nLes utilisateurs devront maintenant rejoindre ce canal avant d'utiliser le bot.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (sub === "supprimer") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal supprimer <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Canal introuvable."); return; }
      await db.delete(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`🗑️ Canal <b>${ch.channelName}</b> supprimé.`, { parse_mode: "HTML" });
      return;
    }

    if (sub === "desactiver") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal desactiver <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Canal introuvable."); return; }
      await db.update(requiredChannelsTable).set({ isActive: false }).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`❌ Canal <b>${ch.channelName}</b> désactivé. Les utilisateurs ne sont plus obligés de le rejoindre.`, { parse_mode: "HTML" });
      return;
    }

    if (sub === "activer") {
      const id = parseInt(parts[1] ?? "", 10);
      if (isNaN(id)) { await ctx.reply("Usage : /admin_canal activer <id>"); return; }
      const [ch] = await db.select().from(requiredChannelsTable).where(eq(requiredChannelsTable.id, id));
      if (!ch) { await ctx.reply("❌ Canal introuvable."); return; }
      await db.update(requiredChannelsTable).set({ isActive: true }).where(eq(requiredChannelsTable.id, id));
      await ctx.reply(`✅ Canal <b>${ch.channelName}</b> activé. Les utilisateurs doivent maintenant le rejoindre.`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      `📢 <b>Gestion des canaux obligatoires</b>\n\n` +
      `/admin_canal liste — voir tous les canaux\n` +
      `/admin_canal ajouter @canal Nom — ajouter un canal\n` +
      `/admin_canal supprimer <id> — supprimer définitivement\n` +
      `/admin_canal desactiver <id> — désactiver temporairement\n` +
      `/admin_canal activer <id> — réactiver`,
      { parse_mode: "HTML" }
    );
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
    const [cc] = await db.select({ c: sql<number>`count(*)::int` }).from(requiredChannelsTable).where(eq(requiredChannelsTable.isActive, true));
    await ctx.reply(
      `📊 <b>Statistiques Communautaires</b>\n\n` +
      `👥 Utilisateurs : <b>${uc?.c ?? 0}</b>\n` +
      `🔗 Parrainages : <b>${rc?.c ?? 0}</b>\n` +
      `💰 Fonds distribués : <b>${(pts?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `📋 Tâches actives : <b>${tc?.c ?? 0}</b>\n` +
      `⏳ Retraits en attente : <b>${pw?.c ?? 0}</b>\n` +
      `✅ Total retiré : <b>${(aw?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `🚨 Comptes frauduleux : <b>${fc?.c ?? 0}</b>\n` +
      `📢 Canaux obligatoires : <b>${cc?.c ?? 0}</b>`,
      { parse_mode: "HTML" }
    );
  });

  // ─── Admin : gestion utilisateurs ────────────────────────────────────────
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
    try { await ctx.telegram.sendMessage(targetId, `🎁 Un administrateur vous a attribué <b>+${amount.toLocaleString("fr-FR")} F</b> !\n💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`, { parse_mode: "HTML" }); } catch { }
    await ctx.reply(`✅ Bonus <b>+${amount.toLocaleString("fr-FR")} F</b> attribué.`, { parse_mode: "HTML" });
  });

  bot.command("admin_ban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage : /admin_ban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "🚫 Votre compte a été suspendu."); } catch { }
    await ctx.reply(`🔨 Utilisateur ${targetId} suspendu.`);
  });

  bot.command("admin_unban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage : /admin_unban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "✅ Votre compte a été réactivé. Bienvenue de retour !"); } catch { }
    await ctx.reply(`✅ Utilisateur ${targetId} réactivé.`);
  });

  bot.command("admin_fraude", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const flagged = await db.select().from(usersTable).where(eq(usersTable.flaggedForFraud, true)).limit(20);
    if (flagged.length === 0) { await ctx.reply("✅ Aucun compte signalé pour fraude."); return; }
    const lines = flagged.map((u) => {
      const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
      return `• ${name} (${u.telegramId}) — ${u.referralCount} parr. — ${u.isBanned ? "🔨 Banni" : "Actif"}`;
    });
    await ctx.reply(`🚨 <b>Comptes Signalés (${flagged.length})</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  // ─── Admin : tâches ──────────────────────────────────────────────────────
  bot.command("admin_tache", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const text = ctx.message.text.replace("/admin_tache", "").trim();
    const parts = text.split("|");
    const firstPart = (parts[0] ?? "").trim().split(" ");
    const reward = parseInt(firstPart[0] ?? "", 10);
    const title = firstPart.slice(1).join(" ").trim();
    const description = (parts[1] ?? "").trim();
    if (isNaN(reward) || !title || !description) {
      await ctx.reply("Usage : /admin_tache <récompense> <titre> | <description>\nEx : /admin_tache 100 Rejoindre notre canal | Rejoignez @canal");
      return;
    }
    const [task] = await db.insert(tasksTable).values({ title, description, rewardAmount: reward, isActive: true }).returning();
    await ctx.reply(`✅ Tâche créée !\n🆔 ID : <b>${task!.id}</b>\n📝 <b>${title}</b>\n💰 +${reward} F`, { parse_mode: "HTML" });
  });

  bot.command("admin_taches", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    if (tasks.length === 0) { await ctx.reply("Aucune tâche."); return; }
    const lines = tasks.map((t) => `${t.isActive ? "✅" : "❌"} [${t.id}] <b>${t.title}</b> — +${t.rewardAmount} F\n   ${t.description}`);
    await ctx.reply(`📋 <b>Toutes les Tâches</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
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
        `💸 <b>Retrait #${w.id}</b>\n👤 ${name} (${w.telegramId})\n💰 ${w.amount.toLocaleString("fr-FR")} F\n💳 ${w.paymentMethod}\n📝 <code>${w.paymentDetails}</code>\n📅 ${w.requestedAt.toLocaleDateString("fr-FR")}\n\n✅ /admin_approuver_${w.id}\n❌ /admin_rejeter_${w.id} <raison>`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.hears(/^\/admin_approuver_(\d+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const withdrawalId = parseInt(ctx.match[1] ?? "", 10);
    if (isNaN(withdrawalId)) { await ctx.reply("❌ ID invalide."); return; }
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, withdrawalId));
    if (!w) { await ctx.reply("❌ Retrait introuvable."); return; }
    if (w.status !== "pending") { await ctx.reply(`⚠️ Ce retrait est déjà : ${w.status}`); return; }
    await db.update(withdrawalsTable).set({ status: "approved", processedAt: new Date() }).where(eq(withdrawalsTable.id, withdrawalId));
    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `✅ <b>Retrait Approuvé !</b>\n\n🆔 #${w.id}\n💰 ${w.amount.toLocaleString("fr-FR")} F\n💳 ${w.paymentMethod}\n\nVotre virement sera traité dans les plus brefs délais. 🎉`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Retrait #${withdrawalId} approuvé. Utilisateur notifié.`);
  });

  bot.hears(/^\/admin_rejeter_(\d+)(?:\s+(.+))?$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const withdrawalId = parseInt(ctx.match[1] ?? "", 10);
    const reason = ctx.match[2]?.trim() ?? "Aucune raison précisée";
    if (isNaN(withdrawalId)) { await ctx.reply("❌ ID invalide."); return; }
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, withdrawalId));
    if (!w) { await ctx.reply("❌ Retrait introuvable."); return; }
    if (w.status !== "pending") { await ctx.reply(`⚠️ Déjà traité : ${w.status}`); return; }
    await db.update(withdrawalsTable).set({ status: "rejected", processedAt: new Date(), adminNote: reason }).where(eq(withdrawalsTable.id, withdrawalId));
    const [restored] = await db.update(usersTable).set({ balance: sql`${usersTable.balance} + ${w.amount}` }).where(eq(usersTable.telegramId, w.telegramId)).returning();
    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `❌ <b>Retrait Refusé</b>\n\n🆔 #${w.id}\n💰 ${w.amount.toLocaleString("fr-FR")} F\n📋 Raison : <i>${reason}</i>\n\n💵 Solde recrédité : <b>${restored!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`❌ Retrait #${withdrawalId} refusé. Solde recrédité. Utilisateur notifié.`);
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Erreur bot non gérée");
  });

  return bot;
}
