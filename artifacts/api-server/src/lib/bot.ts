import { Telegraf, Markup } from "telegraf";
import { eq, sql, desc, and, gt, count } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, referralsTable, tasksTable, userTasksTable, withdrawalsTable } from "@workspace/db";
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

function getRequiredChannel(): string | null {
  return process.env["REQUIRED_CHANNEL"] ?? null;
}

function adminIds(): string[] {
  return (process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function checkChannelMembership(telegram: Telegraf["telegram"], userId: string): Promise<boolean> {
  const channel = getRequiredChannel();
  if (!channel) return true;
  try {
    const member = await telegram.getChatMember(channel, parseInt(userId, 10));
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

async function requireChannel(ctx: any): Promise<boolean> {
  const channel = getRequiredChannel();
  if (!channel) return true;
  const telegramId = String(ctx.from?.id ?? "");
  const isMember = await checkChannelMembership(ctx.telegram, telegramId);
  if (!isMember) {
    await ctx.reply(
      `🔒 <b>Accès requis</b>\n\n` +
      `Pour utiliser ce bot, vous devez d'abord rejoindre notre canal officiel.\n\n` +
      `👇 Cliquez sur le bouton ci-dessous, rejoignez le canal, puis appuyez sur ✅ Vérifier.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.url("📢 Rejoindre le canal", `https://t.me/${channel.replace("@", "")}`)],
          [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
        ]),
      }
    );
    return false;
  }
  return true;
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
  const [recent] = await db
    .select({ c: count() })
    .from(referralsTable)
    .where(
      and(
        eq(referralsTable.referrerId, referrerId),
        gt(referralsTable.createdAt, windowStart)
      )
    );
  if ((recent?.c ?? 0) >= FRAUD_REFERRAL_MAX) return true;

  const referrer = await db.select().from(usersTable).where(eq(usersTable.telegramId, referrerId));
  if (referrer[0]) {
    const timeDiff = Math.abs(referredCreatedAt.getTime() - referrer[0].createdAt.getTime());
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

  bot.action("verify_membership", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? "");
    const isMember = await checkChannelMembership(ctx.telegram, telegramId);
    if (isMember) {
      await ctx.reply("✅ Parfait ! Vous êtes maintenant membre. Bienvenue ! 🎉", mainMenu());
    } else {
      await ctx.reply("❌ Vous n'avez pas encore rejoint le canal. Veuillez rejoindre d'abord puis vérifier à nouveau.");
    }
  });

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
            logger.warn({ referrerId: referredByTelegramId, referredId: telegramId }, "Fraude détectée, parrainage bloqué");
          } else {
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
            try {
              await ctx.telegram.sendMessage(
                referredByTelegramId,
                `🎉 <b>${firstName ?? "Un nouvel utilisateur"}</b> a rejoint via votre lien de parrainage !\n` +
                `Vous avez gagné <b>+${REFERRAL_REWARD} F</b> ! 💰`,
                { parse_mode: "HTML" }
              );
            } catch {
              logger.warn({ referrerId: referredByTelegramId }, "Impossible de notifier le parrain");
            }
          }
        }
      }

      const isMember = await checkChannelMembership(ctx.telegram, telegramId);
      const channel = getRequiredChannel();

      if (!isMember && channel) {
        await ctx.reply(
          `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n` +
          `Pour accéder au bot, vous devez d'abord rejoindre notre canal officiel.`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.url("📢 Rejoindre le canal", `https://t.me/${channel.replace("@", "")}`)],
              [Markup.button.callback("✅ Vérifier mon adhésion", "verify_membership")],
            ]),
          }
        );
      } else {
        const msg = referredByTelegramId
          ? `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> ! Vous avez été parrainé(e).\n\n` +
            `🎁 Complétez des tâches et invitez des amis pour gagner des fonds !\n` +
            `💰 Parrainage = <b>${REFERRAL_REWARD} F</b> | 🎁 Bonus quotidien = <b>${DAILY_BONUS} F</b>`
          : `👋 Bienvenue, <b>${firstName ?? "ami(e)"}</b> !\n\n` +
            `🎁 Complétez des tâches et invitez des amis pour gagner des fonds !\n` +
            `💰 Parrainage = <b>${REFERRAL_REWARD} F</b> | 🎁 Bonus quotidien = <b>${DAILY_BONUS} F</b>`;
        await ctx.reply(msg, { parse_mode: "HTML", ...mainMenu() });
      }
    } else {
      await db.update(usersTable).set({ username, firstName, lastName }).where(eq(usersTable.telegramId, telegramId));
      if (!(await requireChannel(ctx))) return;
      await ctx.reply(
        `🔄 Bon retour, <b>${firstName ?? "ami(e)"}</b> ! 👋\n\nQue souhaitez-vous faire aujourd'hui ?`,
        { parse_mode: "HTML", ...mainMenu() }
      );
    }
  });

  bot.hears("💰 Mon Solde", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    const pendingW = await db.select({ c: count() }).from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    const pending = pendingW[0]?.c ?? 0;

    await ctx.reply(
      `💰 <b>Mon Solde</b>\n\n` +
      `💵 Solde disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n` +
      `👥 Parrainages : <b>${user.referralCount}</b>\n` +
      `✅ Tâches complétées : <b>${user.tasksCompletedCount}</b>\n` +
      (pending > 0 ? `⏳ Retrait en attente : <b>${pending}</b>\n` : "") +
      `\n💡 Retrait minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("🔗 Mon Lien de Parrainage", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    let botUsername = "bot";
    try {
      const me = await ctx.telegram.getMe();
      botUsername = me.username ?? "bot";
    } catch {}

    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const referrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, telegramId));

    await ctx.reply(
      `🔗 <b>Mon Lien de Parrainage</b>\n\n` +
      `Partagez ce lien et gagnez <b>${REFERRAL_REWARD} F</b> pour chaque ami qui s'inscrit !\n\n` +
      `<code>${link}</code>\n\n` +
      `👥 Parrainages effectués : <b>${referrals.length}</b>\n` +
      `💰 Gains totaux parrainage : <b>${(referrals.length * REFERRAL_REWARD).toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("📋 Mes Tâches", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.isActive, true));
    const completedTasks = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    const completedIds = new Set(completedTasks.map((t) => t.taskId));

    if (tasks.length === 0) {
      await ctx.reply("📋 Aucune tâche disponible pour le moment. Revenez bientôt !", mainMenu());
      return;
    }

    const lines = tasks.map((t) => {
      const done = completedIds.has(t.id) ? "✅" : "🔲";
      return `${done} <b>${t.title}</b> — <b>+${t.rewardAmount} F</b>\n   📝 ${t.description}\n   ${done === "✅" ? "<i>Terminée</i>" : `➡️ /valider_${t.id}`}`;
    });

    const doneCount = completedIds.size;
    const totalCount = tasks.length;

    await ctx.reply(
      `📋 <b>Mes Tâches</b>\n\n` +
      `Progression : <b>${doneCount}/${totalCount}</b> tâches complétées\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `💡 Complétez au moins <b>${MIN_TASKS_FOR_BONUS} tâche(s)</b> pour débloquer le bonus quotidien.`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("🏆 Classement", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    const top = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.isBanned, false), eq(usersTable.flaggedForFraud, false)))
      .orderBy(desc(usersTable.referralCount), desc(usersTable.balance))
      .limit(10);

    if (top.length === 0) {
      await ctx.reply("🏆 Aucun utilisateur au classement. Soyez le premier à parrainer !", mainMenu());
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((u, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = u.username ? `@${u.username}` : (u.firstName ?? "Utilisateur");
      const you = u.telegramId === telegramId ? " 👈 <i>vous</i>" : "";
      return `${medal} ${name}${you}\n   👥 ${u.referralCount} filleuls · 💰 ${u.balance.toLocaleString("fr-FR")} F`;
    });

    await ctx.reply(
      `🏆 <b>Classement — Top Parrains</b>\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("🎁 Bonus Quotidien", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    if (user.tasksCompletedCount < MIN_TASKS_FOR_BONUS) {
      await ctx.reply(
        `🎁 <b>Bonus Quotidien</b>\n\n` +
        `❌ Vous devez d'abord compléter au moins <b>${MIN_TASKS_FOR_BONUS} tâche(s)</b> pour débloquer le bonus quotidien.\n\n` +
        `Tâches complétées : <b>${user.tasksCompletedCount}/${MIN_TASKS_FOR_BONUS}</b>\n\n` +
        `Allez dans 📋 Mes Tâches pour commencer !`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }

    const now = new Date();
    if (user.lastDailyBonusAt) {
      const hoursSince = (now.getTime() - user.lastDailyBonusAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < DAILY_BONUS_HOURS) {
        const nextBonus = new Date(user.lastDailyBonusAt.getTime() + DAILY_BONUS_HOURS * 60 * 60 * 1000);
        const diff = nextBonus.getTime() - now.getTime();
        const h = Math.floor(diff / (1000 * 60 * 60));
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        await ctx.reply(
          `🎁 <b>Bonus Quotidien</b>\n\n` +
          `⏳ Vous avez déjà réclamé votre bonus aujourd'hui.\n\n` +
          `Prochain bonus disponible dans : <b>${h}h ${m}min</b>\n\n` +
          `💰 Solde actuel : <b>${user.balance.toLocaleString("fr-FR")} F</b>`,
          { parse_mode: "HTML", ...mainMenu() }
        );
        return;
      }
    }

    const [updated] = await db.update(usersTable)
      .set({
        balance: sql`${usersTable.balance} + ${DAILY_BONUS}`,
        lastDailyBonusAt: now,
      })
      .where(eq(usersTable.telegramId, telegramId))
      .returning();

    await ctx.reply(
      `🎁 <b>Bonus Quotidien Réclamé !</b>\n\n` +
      `✅ Vous avez reçu <b>+${DAILY_BONUS} F</b> !\n\n` +
      `💰 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>\n\n` +
      `Revenez demain pour un nouveau bonus ! ⏰`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("💸 Retrait", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    if (user.balance < MIN_WITHDRAWAL) {
      await ctx.reply(
        `💸 <b>Retrait</b>\n\n` +
        `❌ Solde insuffisant.\n\n` +
        `💰 Votre solde : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n` +
        `📊 Minimum requis : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n\n` +
        `Continuez à parrainer et à compléter des tâches pour atteindre le minimum !`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }

    const pendingW = await db.select().from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.telegramId, telegramId), eq(withdrawalsTable.status, "pending")));
    if (pendingW.length > 0) {
      await ctx.reply(
        `💸 <b>Retrait</b>\n\n` +
        `⏳ Vous avez déjà un retrait en attente d'approbation.\n` +
        `Veuillez attendre la décision de l'administrateur avant d'en faire un nouveau.`,
        { parse_mode: "HTML", ...mainMenu() }
      );
      return;
    }

    convState.set(telegramId, { step: "awaiting_amount" });
    await ctx.reply(
      `💸 <b>Demande de Retrait</b>\n\n` +
      `💰 Votre solde disponible : <b>${user.balance.toLocaleString("fr-FR")} F</b>\n` +
      `📊 Minimum de retrait : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n\n` +
      `💡 <b>Combien souhaitez-vous retirer ?</b>\nEntrez le montant en francs (ex: 10000) :`,
      {
        parse_mode: "HTML",
        ...Markup.keyboard([["❌ Annuler"]]).resize(),
      }
    );
  });

  bot.hears("📜 Historique des Retraits", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;
    await showWithdrawalHistory(ctx, telegramId);
  });

  bot.hears("ℹ️ Aide", async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    await ctx.reply(
      `ℹ️ <b>Comment ça marche ?</b>\n\n` +
      `💰 <b>Mon Solde</b> — voir vos fonds et statistiques\n` +
      `🔗 <b>Mon Lien de Parrainage</b> — obtenez votre lien unique\n` +
      `📋 <b>Mes Tâches</b> — complétez des missions pour gagner\n` +
      `🏆 <b>Classement</b> — les meilleurs parrains\n` +
      `🎁 <b>Bonus Quotidien</b> — réclamez ${DAILY_BONUS} F chaque jour\n` +
      `💸 <b>Retrait</b> — demandez un virement de vos fonds\n\n` +
      `<b>💵 Comment gagner des fonds :</b>\n` +
      `• Parrainer un ami → <b>+${REFERRAL_REWARD} F</b> par inscription\n` +
      `• Compléter des tâches → montant variable\n` +
      `• Bonus quotidien → <b>+${DAILY_BONUS} F</b>/jour (après ${MIN_TASKS_FOR_BONUS} tâche)\n\n` +
      `<b>💸 Retrait :</b>\n` +
      `• Minimum : <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>\n` +
      `• Approbation par un administrateur requise\n` +
      `• Vous serez notifié par message\n\n` +
      `<b>🛡️ Anti-fraude :</b>\n` +
      `• Les faux parrainages sont détectés et sanctionnés\n` +
      `• Les comptes multiples sont bloqués automatiquement`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("❌ Annuler", async (ctx) => {
    const telegramId = String(ctx.from.id);
    convState.delete(telegramId);
    await ctx.reply("❌ Action annulée.", mainMenu());
  });

  bot.hears(/^\/valider_(\d+)$/, async (ctx) => {
    if (!(await requireChannel(ctx))) return;
    const telegramId = String(ctx.from.id);
    const user = await getOrFailUser(ctx, telegramId);
    if (!user) return;

    const match = ctx.match;
    const taskId = match ? parseInt(match[1] ?? "", 10) : NaN;
    if (isNaN(taskId)) { await ctx.reply("❌ Identifiant de tâche invalide."); return; }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task || !task.isActive) {
      await ctx.reply("❌ Cette tâche n'existe pas ou n'est plus disponible.");
      return;
    }

    const existing = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    if (existing.some((t) => t.taskId === taskId)) {
      await ctx.reply(`✅ Vous avez déjà complété la tâche <b>"${task.title}"</b>.`, { parse_mode: "HTML" });
      return;
    }

    await db.insert(userTasksTable).values({ telegramId, taskId, rewardAmount: task.rewardAmount });
    const [updated] = await db.update(usersTable)
      .set({
        balance: sql`${usersTable.balance} + ${task.rewardAmount}`,
        tasksCompletedCount: sql`${usersTable.tasksCompletedCount} + 1`,
      })
      .where(eq(usersTable.telegramId, telegramId))
      .returning();

    await ctx.reply(
      `🎉 <b>Tâche complétée !</b>\n\n` +
      `✅ <b>"${task.title}"</b>\n` +
      `💰 Récompense : <b>+${task.rewardAmount} F</b>\n` +
      `💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.on("text", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const state = convState.get(telegramId);
    if (!state) return;

    const text = ctx.message.text.trim();

    if (state.step === "awaiting_amount") {
      const amount = parseInt(text.replace(/\s/g, ""), 10);
      if (isNaN(amount) || amount < MIN_WITHDRAWAL) {
        await ctx.reply(
          `❌ Montant invalide. Le minimum est de <b>${MIN_WITHDRAWAL.toLocaleString("fr-FR")} F</b>.\nEntrez un montant valide :`,
          { parse_mode: "HTML" }
        );
        return;
      }
      const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
      if (!user || amount > user.balance) {
        await ctx.reply(`❌ Solde insuffisant. Votre solde : <b>${user?.balance.toLocaleString("fr-FR") ?? 0} F</b>`, { parse_mode: "HTML" });
        convState.delete(telegramId);
        await ctx.reply("Retrait annulé.", mainMenu());
        return;
      }
      state.step = "awaiting_method";
      state.amount = amount;
      convState.set(telegramId, state);
      await ctx.reply(
        `💳 <b>Mode de paiement</b>\n\nChoisissez votre méthode de retrait :`,
        {
          parse_mode: "HTML",
          ...Markup.keyboard([
            ["📱 Mobile Money", "🏦 Virement Bancaire"],
            ["💰 PayPal", "🔐 Crypto (USDT/BTC)"],
            ["❌ Annuler"],
          ]).resize(),
        }
      );
      return;
    }

    if (state.step === "awaiting_method") {
      const validMethods = ["📱 Mobile Money", "🏦 Virement Bancaire", "💰 PayPal", "🔐 Crypto (USDT/BTC)"];
      if (!validMethods.includes(text)) {
        await ctx.reply("❌ Veuillez choisir une méthode parmi les options proposées.");
        return;
      }
      state.step = "awaiting_details";
      state.method = text;
      convState.set(telegramId, state);

      const prompts: Record<string, string> = {
        "📱 Mobile Money": "Entrez votre numéro de téléphone Mobile Money (ex: +225 07 00 00 00 00) :",
        "🏦 Virement Bancaire": "Entrez vos coordonnées bancaires (IBAN + Nom du titulaire) :",
        "💰 PayPal": "Entrez votre adresse e-mail PayPal :",
        "🔐 Crypto (USDT/BTC)": "Entrez votre adresse de wallet (précisez le réseau, ex: TRC20) :",
      };
      await ctx.reply(
        `📝 <b>Coordonnées de paiement</b>\n\n${prompts[text] ?? "Entrez vos coordonnées :"}`,
        { parse_mode: "HTML", ...Markup.keyboard([["❌ Annuler"]]).resize() }
      );
      return;
    }

    if (state.step === "awaiting_details") {
      if (!state.amount || !state.method) {
        convState.delete(telegramId);
        await ctx.reply("❌ Erreur de session. Veuillez recommencer.", mainMenu());
        return;
      }

      const [withdrawal] = await db.insert(withdrawalsTable).values({
        telegramId,
        amount: state.amount,
        paymentMethod: state.method,
        paymentDetails: text,
        status: "pending",
      }).returning();

      const [updatedUser] = await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${state.amount}` })
        .where(eq(usersTable.telegramId, telegramId))
        .returning();

      convState.delete(telegramId);

      await ctx.reply(
        `✅ <b>Demande de retrait enregistrée !</b>\n\n` +
        `🆔 Référence : <b>#${withdrawal!.id}</b>\n` +
        `💰 Montant : <b>${state.amount.toLocaleString("fr-FR")} F</b>\n` +
        `💳 Méthode : <b>${state.method}</b>\n` +
        `📋 Statut : <b>⏳ En attente</b>\n\n` +
        `💵 Solde restant : <b>${updatedUser!.balance.toLocaleString("fr-FR")} F</b>\n\n` +
        `Vous serez notifié dès que l'administrateur aura traité votre demande.`,
        { parse_mode: "HTML", ...mainMenu() }
      );

      for (const adminId of adminIds()) {
        try {
          const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
          const name = user?.username ? `@${user.username}` : user?.firstName ?? telegramId;
          await ctx.telegram.sendMessage(
            adminId,
            `💸 <b>Nouvelle demande de retrait !</b>\n\n` +
            `👤 Utilisateur : <b>${name}</b> (${telegramId})\n` +
            `🆔 Retrait #${withdrawal!.id}\n` +
            `💰 Montant : <b>${state.amount.toLocaleString("fr-FR")} F</b>\n` +
            `💳 Méthode : <b>${state.method}</b>\n` +
            `📝 Coordonnées : <code>${text}</code>\n\n` +
            `➡️ /admin_approuver_${withdrawal!.id}\n` +
            `❌ /admin_rejeter_${withdrawal!.id} <raison>`,
            { parse_mode: "HTML" }
          );
        } catch { }
      }
      return;
    }
  });

  bot.command("admin", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    await ctx.reply(
      `🔧 <b>Panneau Administrateur</b>\n\n` +
      `📊 <b>Statistiques</b>\n` +
      `/admin_stats — statistiques communautaires\n\n` +
      `👥 <b>Utilisateurs</b>\n` +
      `/admin_solde <id> <montant> — ajuster le solde\n` +
      `/admin_bonus <id> <montant> — attribuer un bonus\n` +
      `/admin_ban <id> — suspendre un utilisateur\n` +
      `/admin_unban <id> — réactiver un utilisateur\n` +
      `/admin_fraude — utilisateurs signalés\n\n` +
      `📋 <b>Tâches</b>\n` +
      `/admin_tache <récompense> <titre> | <description>\n` +
      `/admin_taches — liste de toutes les tâches\n\n` +
      `💸 <b>Retraits</b>\n` +
      `/admin_retraits — retraits en attente\n` +
      `/admin_approuver_<id> — approuver un retrait\n` +
      `/admin_rejeter_<id> <raison> — rejeter un retrait`,
      { parse_mode: "HTML" }
    );
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
    await ctx.reply(
      `📊 <b>Statistiques Communautaires</b>\n\n` +
      `👥 Utilisateurs : <b>${uc?.c ?? 0}</b>\n` +
      `🔗 Parrainages : <b>${rc?.c ?? 0}</b>\n` +
      `💰 Total fonds distribués : <b>${(pts?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `📋 Tâches actives : <b>${tc?.c ?? 0}</b>\n` +
      `⏳ Retraits en attente : <b>${pw?.c ?? 0}</b>\n` +
      `✅ Total retiré : <b>${(aw?.s ?? 0).toLocaleString("fr-FR")} F</b>\n` +
      `🚨 Comptes frauduleux : <b>${fc?.c ?? 0}</b>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_solde", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount)) {
      await ctx.reply("Usage : /admin_solde <telegramId> <montant>\nEx : /admin_solde 123456789 500");
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}` })
      .where(eq(usersTable.telegramId, targetId))
      .returning();
    await ctx.reply(`✅ Solde mis à jour. ${targetId} a maintenant <b>${updated!.balance.toLocaleString("fr-FR")} F</b>.`, { parse_mode: "HTML" });
  });

  bot.command("admin_bonus", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount) || amount <= 0) {
      await ctx.reply("Usage : /admin_bonus <telegramId> <montant>");
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}` })
      .where(eq(usersTable.telegramId, targetId))
      .returning();
    try {
      await ctx.telegram.sendMessage(targetId,
        `🎁 <b>Bonus reçu !</b>\n\nUn administrateur vous a attribué un bonus de <b>+${amount.toLocaleString("fr-FR")} F</b> !\n💵 Nouveau solde : <b>${updated!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Bonus de <b>+${amount.toLocaleString("fr-FR")} F</b> attribué à ${targetId}.`, { parse_mode: "HTML" });
  });

  bot.command("admin_ban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage : /admin_ban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("❌ Utilisateur introuvable."); return; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, targetId));
    try { await ctx.telegram.sendMessage(targetId, "🚫 Votre compte a été suspendu par un administrateur."); } catch { }
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

  bot.command("admin_tache", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const text = ctx.message.text.replace("/admin_tache", "").trim();
    const parts = text.split("|");
    const firstPart = (parts[0] ?? "").trim().split(" ");
    const reward = parseInt(firstPart[0] ?? "", 10);
    const title = firstPart.slice(1).join(" ").trim();
    const description = (parts[1] ?? "").trim();
    if (isNaN(reward) || !title || !description) {
      await ctx.reply("Usage : /admin_tache <récompense> <titre> | <description>\nEx : /admin_tache 100 Rejoindre notre canal | Rejoignez @canal et restez membre");
      return;
    }
    const [task] = await db.insert(tasksTable).values({ title, description, rewardAmount: reward, isActive: true }).returning();
    await ctx.reply(`✅ Tâche créée !\n🆔 ID : <b>${task!.id}</b>\n📝 Titre : <b>${title}</b>\n💰 Récompense : <b>+${reward} F</b>`, { parse_mode: "HTML" });
  });

  bot.command("admin_taches", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    if (tasks.length === 0) { await ctx.reply("Aucune tâche pour le moment."); return; }
    const lines = tasks.map((t) => `${t.isActive ? "✅" : "❌"} [${t.id}] <b>${t.title}</b> — +${t.rewardAmount} F\n   ${t.description}`);
    await ctx.reply(`📋 <b>Toutes les Tâches</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.command("admin_retraits", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const pending = await db.select().from(withdrawalsTable)
      .where(eq(withdrawalsTable.status, "pending"))
      .orderBy(withdrawalsTable.requestedAt)
      .limit(20);
    if (pending.length === 0) { await ctx.reply("✅ Aucun retrait en attente."); return; }

    for (const w of pending) {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, w.telegramId));
      const name = user?.username ? `@${user.username}` : user?.firstName ?? w.telegramId;
      await ctx.reply(
        `💸 <b>Retrait #${w.id}</b>\n\n` +
        `👤 ${name} (${w.telegramId})\n` +
        `💰 Montant : <b>${w.amount.toLocaleString("fr-FR")} F</b>\n` +
        `💳 Méthode : <b>${w.paymentMethod}</b>\n` +
        `📝 Coordonnées : <code>${w.paymentDetails}</code>\n` +
        `📅 Demandé le : ${w.requestedAt.toLocaleDateString("fr-FR")}\n\n` +
        `✅ /admin_approuver_${w.id}\n` +
        `❌ /admin_rejeter_${w.id} <raison>`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.hears(/^\/admin_approuver_(\d+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const match = ctx.match;
    const withdrawalId = match ? parseInt(match[1] ?? "", 10) : NaN;
    if (isNaN(withdrawalId)) { await ctx.reply("❌ ID invalide."); return; }
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, withdrawalId));
    if (!w) { await ctx.reply("❌ Retrait introuvable."); return; }
    if (w.status !== "pending") { await ctx.reply(`⚠️ Ce retrait est déjà : ${w.status}`); return; }
    await db.update(withdrawalsTable).set({ status: "approved", processedAt: new Date() }).where(eq(withdrawalsTable.id, withdrawalId));
    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `✅ <b>Retrait Approuvé !</b>\n\n` +
        `🆔 Retrait #${w.id}\n` +
        `💰 Montant : <b>${w.amount.toLocaleString("fr-FR")} F</b>\n` +
        `💳 Méthode : <b>${w.paymentMethod}</b>\n\n` +
        `Votre virement a été validé et sera traité dans les plus brefs délais. 🎉`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`✅ Retrait #${withdrawalId} approuvé. L'utilisateur a été notifié.`);
  });

  bot.hears(/^\/admin_rejeter_(\d+)(?:\s+(.+))?$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const match = ctx.match;
    const withdrawalId = match ? parseInt(match[1] ?? "", 10) : NaN;
    const reason = match?.[2]?.trim() ?? "Aucune raison précisée";
    if (isNaN(withdrawalId)) { await ctx.reply("❌ ID invalide."); return; }
    const [w] = await db.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, withdrawalId));
    if (!w) { await ctx.reply("❌ Retrait introuvable."); return; }
    if (w.status !== "pending") { await ctx.reply(`⚠️ Ce retrait est déjà : ${w.status}`); return; }
    await db.update(withdrawalsTable).set({ status: "rejected", processedAt: new Date(), adminNote: reason }).where(eq(withdrawalsTable.id, withdrawalId));
    const [restored] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${w.amount}` })
      .where(eq(usersTable.telegramId, w.telegramId))
      .returning();
    try {
      await ctx.telegram.sendMessage(w.telegramId,
        `❌ <b>Retrait Refusé</b>\n\n` +
        `🆔 Retrait #${w.id}\n` +
        `💰 Montant : <b>${w.amount.toLocaleString("fr-FR")} F</b>\n` +
        `📋 Raison : <i>${reason}</i>\n\n` +
        `💵 Votre solde a été recrédité : <b>${restored!.balance.toLocaleString("fr-FR")} F</b>`,
        { parse_mode: "HTML" });
    } catch { }
    await ctx.reply(`❌ Retrait #${withdrawalId} refusé. Solde recrédité. L'utilisateur a été notifié.`);
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Erreur bot non gérée");
  });

  return bot;
}

async function showWithdrawalHistory(ctx: any, telegramId: string) {
  const history = await db.select().from(withdrawalsTable)
    .where(eq(withdrawalsTable.telegramId, telegramId))
    .orderBy(desc(withdrawalsTable.requestedAt))
    .limit(10);

  if (history.length === 0) {
    await ctx.reply("📜 Vous n'avez aucun historique de retrait.", mainMenu());
    return;
  }

  const statusEmoji: Record<string, string> = { pending: "⏳", approved: "✅", rejected: "❌" };
  const statusLabel: Record<string, string> = { pending: "En attente", approved: "Approuvé", rejected: "Refusé" };

  const lines = history.map((w) => {
    const emoji = statusEmoji[w.status] ?? "❓";
    const label = statusLabel[w.status] ?? w.status;
    const date = w.requestedAt.toLocaleDateString("fr-FR");
    return `${emoji} <b>#${w.id}</b> — ${w.amount.toLocaleString("fr-FR")} F\n   💳 ${w.paymentMethod} · ${date} · ${label}` +
      (w.adminNote ? `\n   📝 <i>${w.adminNote}</i>` : "");
  });

  await ctx.reply(
    `📜 <b>Historique des Retraits</b>\n\n${lines.join("\n\n")}`,
    { parse_mode: "HTML", ...mainMenu() }
  );
}
