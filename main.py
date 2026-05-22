import asyncio
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
) TOKEN = 
"8844630275:AAEJe0EiCUcoG7vC4qI9VOarZEsjx77_ZuE"# 
START async def start(update: 
Update, context: 
ContextTypes.DEFAULT_TYPE):

    user_id = 
    update.effective_user.id 
    first_name = 
    update.effective_user.first_name
users = {}
    if user_id not in users:
        users[user_id] = {
            "balance": 0,
            "referrals": 0
        }

    # Referral
    if context.args:

        try:
            referrer = int(context.args[0])

            if referrer != user_id and referrer in users:
                users[referrer]["balance"] += 100
                users[referrer]["referrals"] += 1

        except:
            pass

    text = (
        f"🔥 Bienvenue {first_name}\n\n"
        f"Commandes disponibles :\n\n"
        f"/balance - Voir balance\n"
        f"/bonus - Bonus\n"
        f"/referral - Lien referral\n"
        f"/withdraw - Retrait\n"
        f"/stats - Statistiques\n"
        f"/help - Aide"
    )

    await update.message.reply_text(text)

# BALANCE
async def balance(update: Update, context: ContextTypes.DEFAULT_TYPE):

    user_id = update.effective_user.id

    if user_id not in users:
        users[user_id] = {
            "balance": 0,
            "referrals": 0
        }

    balance = users[user_id]["balance"]

    await update.message.reply_text(
        f"💰 Balance : {balance} FCFA"
    )

# BONUS
async def bonus(update: Update, context: ContextTypes.DEFAULT_TYPE):

    user_id = update.effective_user.id

    if user_id not in users:
        users[user_id] = {
            "balance": 0,
            "referrals": 0
        }

    users[user_id]["balance"] += 50

    await update.message.reply_text(
        "🎁 Bonus reçu : 50 FCFA"
    )

# REFERRAL
async def referral(update: Update, context: ContextTypes.DEFAULT_TYPE):

    user_id = update.effective_user.id

    await update.message.reply_text(
        f"👥 Ton lien :\n\n"
        f"https://t.me/network_reward_bot?start={user_id}"
    )

# WITHDRAW
async def withdraw(update: Update, context: ContextTypes.DEFAULT_TYPE):

    user_id = update.effective_user.id

    balance = users[user_id]["balance"]

    if balance >= 1000:

        users[user_id]["balance"] = 0

        await update.message.reply_text(
            "✅ Retrait envoyé"
        )

    else:

        await update.message.reply_text(
            "❌ Minimum retrait : 1000 FCFA"
        )

# STATS
async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):

    total = len(users)

    await update.message.reply_text(
        f"📊 Utilisateurs : {total}"
    )

# HELP
async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):

    await update.message.reply_text(
        "/start\n"
        "/balance\n"
        "/bonus\n"
        "/referral\n"
        "/withdraw\n"
        "/stats"
    )

# ERROR
async def error_handler(update, context):

    print(context.error)

async def main():

    app = (
        Application.builder()
        .token(TOKEN)
        .concurrent_updates(True)
        .build()
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("balance", balance))
    app.add_handler(CommandHandler("bonus", bonus))
    app.add_handler(CommandHandler("referral", referral))
    app.add_handler(CommandHandler("withdraw", withdraw))
    app.add_handler(CommandHandler("stats", stats))
    app.add_handler(CommandHandler("help", help_command))

    app.add_error_handler(error_handler)

    print("🚀 Bot ultra rapide lancé")

    await app.initialize()
    await app.start()
    await app.updater.start_polling(
        drop_pending_updates=True
    )

    while True:
        await asyncio.sleep(3600)

asyncio.run(main())
