import { Telegraf, Markup } from "telegraf";
import { eq, sql, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, referralsTable, tasksTable, userTasksTable } from "@workspace/db";
import { logger } from "./logger";

const REFERRAL_REWARD = 50;
const BOT_USERNAME_PLACEHOLDER = "your_bot";

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

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
      await db.insert(usersTable).values({
        telegramId,
        username,
        firstName,
        lastName,
        referredByTelegramId,
        balance: 0,
        referralCount: 0,
      }).onConflictDoNothing();

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

          try {
            const referrerName = referrer.username ? `@${referrer.username}` : referrer.firstName ?? "Someone";
            await ctx.telegram.sendMessage(
              referredByTelegramId,
              `🎉 <b>${firstName ?? "A new user"}</b> just joined using your referral link!\nYou earned <b>+${REFERRAL_REWARD} points</b>! 💰`,
              { parse_mode: "HTML" }
            );
            logger.info({ referrerId: referredByTelegramId, referredId: telegramId }, `Referral reward sent to ${referrerName}`);
          } catch {
            logger.warn({ referrerId: referredByTelegramId }, "Could not notify referrer");
          }
        }
      }

      const welcomeMsg = referredByTelegramId
        ? `👋 Welcome, <b>${firstName ?? "friend"}</b>! You joined via a referral link.\n\nYou're now part of our community! Start earning points by inviting friends and completing tasks.`
        : `👋 Welcome, <b>${firstName ?? "friend"}</b>!\n\nYou're now part of our community! Start earning points by inviting friends and completing tasks.`;

      await ctx.reply(welcomeMsg, {
        parse_mode: "HTML",
        ...mainMenu(),
      });
    } else {
      await db.update(usersTable).set({ username, firstName, lastName }).where(eq(usersTable.telegramId, telegramId));
      await ctx.reply(`Welcome back, <b>${firstName ?? "friend"}</b>! 👋`, {
        parse_mode: "HTML",
        ...mainMenu(),
      });
    }
  });

  bot.hears("💰 My Balance", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("Please start with /start first."); return; }
    if (user.isBanned) { await ctx.reply("Your account has been banned."); return; }

    await ctx.reply(
      `💰 <b>Your Balance</b>\n\n` +
      `Points: <b>${user.balance} pts</b>\n` +
      `Referrals: <b>${user.referralCount}</b>\n\n` +
      `Keep inviting friends and completing tasks to earn more!`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("🔗 My Referral Link", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("Please start with /start first."); return; }
    if (user.isBanned) { await ctx.reply("Your account has been banned."); return; }

    let botUsername = BOT_USERNAME_PLACEHOLDER;
    try {
      const me = await ctx.telegram.getMe();
      botUsername = me.username ?? BOT_USERNAME_PLACEHOLDER;
    } catch {}

    const link = `https://t.me/${botUsername}?start=${telegramId}`;
    const referrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, telegramId));

    await ctx.reply(
      `🔗 <b>Your Referral Link</b>\n\n` +
      `Share this link to earn <b>${REFERRAL_REWARD} points</b> for every friend who joins!\n\n` +
      `<code>${link}</code>\n\n` +
      `👥 Total referrals: <b>${referrals.length}</b>`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("📋 Tasks", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("Please start with /start first."); return; }
    if (user.isBanned) { await ctx.reply("Your account has been banned."); return; }

    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.isActive, true));
    const completedTasks = await db.select().from(userTasksTable).where(eq(userTasksTable.telegramId, telegramId));
    const completedIds = new Set(completedTasks.map((t) => t.taskId));

    if (tasks.length === 0) {
      await ctx.reply("No active tasks right now. Check back soon!", mainMenu());
      return;
    }

    const lines = tasks.map((t) => {
      const done = completedIds.has(t.id) ? "✅" : "🔲";
      return `${done} <b>${t.title}</b> — +${t.rewardAmount} pts\n   ${t.description}`;
    });

    await ctx.reply(
      `📋 <b>Available Tasks</b>\n\n${lines.join("\n\n")}\n\n` +
      `Use /complete_<task_id> to complete a task.\nExample: /complete_1`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("🏆 Leaderboard", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("Please start with /start first."); return; }

    const top = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.isBanned, false))
      .orderBy(desc(usersTable.referralCount), desc(usersTable.balance))
      .limit(10);

    if (top.length === 0) {
      await ctx.reply("No users yet! Be the first to invite friends.", mainMenu());
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((u, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = u.username ? `@${u.username}` : (u.firstName ?? "User");
      const you = u.telegramId === telegramId ? " 👈 you" : "";
      return `${medal} ${name}${you} — ${u.referralCount} referrals · ${u.balance} pts`;
    });

    await ctx.reply(
      `🏆 <b>Leaderboard — Top Referrers</b>\n\n${lines.join("\n")}`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.hears("ℹ️ Help", async (ctx) => {
    await ctx.reply(
      `ℹ️ <b>How this bot works</b>\n\n` +
      `💰 <b>My Balance</b> — see your points and referral count\n` +
      `🔗 <b>My Referral Link</b> — get your unique invite link\n` +
      `📋 <b>Tasks</b> — complete tasks to earn bonus points\n` +
      `🏆 <b>Leaderboard</b> — see the top community members\n\n` +
      `<b>Earning points:</b>\n` +
      `• Invite a friend → +${REFERRAL_REWARD} pts per referral\n` +
      `• Complete tasks → points vary per task\n\n` +
      `Future features: crypto withdrawals, token rewards, and more!`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.command("complete", async (ctx) => {
    await ctx.reply("Usage: /complete_<task_id>  e.g. /complete_1");
  });

  bot.hears(/^\/complete_(\d+)$/, async (ctx) => {
    const telegramId = String(ctx.from.id);
    const match = ctx.match;
    const taskId = match ? parseInt(match[1] ?? "", 10) : NaN;
    if (isNaN(taskId)) { await ctx.reply("Invalid task ID."); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
    if (!user) { await ctx.reply("Please start with /start first."); return; }
    if (user.isBanned) { await ctx.reply("Your account has been banned."); return; }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task || !task.isActive) { await ctx.reply("Task not found or no longer active."); return; }

    const existing = await db.select().from(userTasksTable)
      .where(eq(userTasksTable.telegramId, telegramId));
    if (existing.some((t) => t.taskId === taskId)) {
      await ctx.reply(`You already completed "<b>${task.title}</b>".`, { parse_mode: "HTML" });
      return;
    }

    await db.insert(userTasksTable).values({ telegramId, taskId, rewardAmount: task.rewardAmount });
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${task.rewardAmount}` })
      .where(eq(usersTable.telegramId, telegramId))
      .returning();

    await ctx.reply(
      `✅ Task "<b>${task.title}</b>" completed!\n` +
      `You earned <b>+${task.rewardAmount} pts</b>!\n` +
      `New balance: <b>${updated!.balance} pts</b> 💰`,
      { parse_mode: "HTML", ...mainMenu() }
    );
  });

  bot.command("admin", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const adminIds = (process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!adminIds.includes(telegramId)) {
      await ctx.reply("You are not authorized to use admin commands.");
      return;
    }
    await ctx.reply(
      `🔧 <b>Admin Commands</b>\n\n` +
      `/admin_stats — community stats\n` +
      `/admin_balance <telegramId> <amount> — adjust balance\n` +
      `/admin_bonus <telegramId> <amount> — grant bonus\n` +
      `/admin_ban <telegramId> — ban user\n` +
      `/admin_unban <telegramId> — unban user\n` +
      `/admin_addtask <reward> <title> | <description> — create task\n` +
      `/admin_tasks — list all tasks`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_stats", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const [userCount] = await db.select({ c: sql<number>`count(*)::int` }).from(usersTable);
    const [refCount] = await db.select({ c: sql<number>`count(*)::int` }).from(referralsTable);
    const [pts] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(usersTable);
    const [taskCount] = await db.select({ c: sql<number>`count(*)::int` }).from(tasksTable).where(eq(tasksTable.isActive, true));
    await ctx.reply(
      `📊 <b>Community Stats</b>\n\n` +
      `👥 Total users: <b>${userCount?.c ?? 0}</b>\n` +
      `🔗 Total referrals: <b>${refCount?.c ?? 0}</b>\n` +
      `💰 Total points issued: <b>${pts?.s ?? 0}</b>\n` +
      `📋 Active tasks: <b>${taskCount?.c ?? 0}</b>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("admin_balance", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount)) {
      await ctx.reply("Usage: /admin_balance <telegramId> <amount>");
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("User not found."); return; }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}` })
      .where(eq(usersTable.telegramId, targetId))
      .returning();
    await ctx.reply(`✅ Balance updated. ${targetId} now has <b>${updated!.balance} pts</b>.`, { parse_mode: "HTML" });
  });

  bot.command("admin_bonus", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    const amount = parseInt(parts[2] ?? "", 10);
    if (!targetId || isNaN(amount) || amount <= 0) {
      await ctx.reply("Usage: /admin_bonus <telegramId> <amount>");
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("User not found."); return; }
    const [updated] = await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}` })
      .where(eq(usersTable.telegramId, targetId))
      .returning();
    try {
      await ctx.telegram.sendMessage(targetId, `🎁 You received a bonus of <b>+${amount} pts</b> from an admin!\nNew balance: <b>${updated!.balance} pts</b>`, { parse_mode: "HTML" });
    } catch {}
    await ctx.reply(`✅ Bonus of <b>+${amount} pts</b> granted to ${targetId}.`, { parse_mode: "HTML" });
  });

  bot.command("admin_ban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage: /admin_ban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("User not found."); return; }
    await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.telegramId, targetId));
    await ctx.reply(`🔨 User ${targetId} has been banned.`);
  });

  bot.command("admin_unban", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) { await ctx.reply("Usage: /admin_unban <telegramId>"); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
    if (!user) { await ctx.reply("User not found."); return; }
    await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.telegramId, targetId));
    await ctx.reply(`✅ User ${targetId} has been unbanned.`);
  });

  bot.command("admin_addtask", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const text = ctx.message.text.replace("/admin_addtask", "").trim();
    const parts = text.split("|");
    const firstPart = (parts[0] ?? "").trim().split(" ");
    const reward = parseInt(firstPart[0] ?? "", 10);
    const title = firstPart.slice(1).join(" ").trim();
    const description = (parts[1] ?? "").trim();
    if (isNaN(reward) || !title || !description) {
      await ctx.reply("Usage: /admin_addtask <reward> <title> | <description>\nExample: /admin_addtask 20 Join our channel | Join @mychannel and stay a member");
      return;
    }
    const [task] = await db.insert(tasksTable).values({ title, description, rewardAmount: reward, isActive: true }).returning();
    await ctx.reply(`✅ Task created!\nID: <b>${task!.id}</b>\nTitle: <b>${title}</b>\nReward: <b>+${reward} pts</b>\nDescription: ${description}`, { parse_mode: "HTML" });
  });

  bot.command("admin_tasks", async (ctx) => {
    if (!(await isAdmin(ctx))) return;
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    if (tasks.length === 0) { await ctx.reply("No tasks yet."); return; }
    const lines = tasks.map((t) => `${t.isActive ? "✅" : "❌"} [${t.id}] <b>${t.title}</b> — +${t.rewardAmount} pts\n   ${t.description}`);
    await ctx.reply(`📋 <b>All Tasks</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Unhandled bot error");
  });

  return bot;
}

function mainMenu() {
  return Markup.keyboard([
    ["💰 My Balance", "🔗 My Referral Link"],
    ["📋 Tasks", "🏆 Leaderboard"],
    ["ℹ️ Help"],
  ]).resize();
}

async function isAdmin(ctx: { from?: { id: number }; reply: (msg: string) => Promise<unknown> }): Promise<boolean> {
  const adminIds = (process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const telegramId = String(ctx.from?.id ?? "");
  if (!adminIds.includes(telegramId)) {
    await ctx.reply("You are not authorized to use admin commands.");
    return false;
  }
  return true;
}
