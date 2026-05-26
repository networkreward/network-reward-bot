from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
import sqlite3

TOKEN = "8844630275:AAFc2lwkSN6XfRUGRI0WjJvhfbAOZSomr9E"
BOT_USERNAME = "network_reward_bot"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    user_id = user.id

    conn = sqlite3.connect("data.db")
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    existing_user = cursor.fetchone()

    if not existing_user:
        cursor.execute(
            "INSERT INTO users (user_id, referrals, balance) VALUES (?, ?, ?)",
            (user_id, 0, 0)
        )
        conn.commit()

    referral_link = f"https://t.me/{BOT_USERNAME}?start={user_id}"

    await update.message.reply_text(
        f"🚀 Bienvenue {user.first_name} !\n\n"
        f"🔗 Ton lien de parrainage :\n{referral_link}"
    )

    conn.close()

async def profile(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id

    conn = sqlite3.connect("data.db")
    cursor = conn.cursor()

    cursor.execute(
        "SELECT referrals, balance FROM users WHERE user_id = ?",
        (user_id,)
    )

    user_data = cursor.fetchone()

    referrals = user_data[0]
    balance = user_data[1]

    await update.message.reply_text(
        f"👤 Ton profil\n\n"
        f"👥 Referrals : {referrals}\n"
        f"💰 Balance : {balance} coins"
    )

    conn.close()

app = ApplicationBuilder().token(TOKEN).build()

app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("profile", profile))

print("Bot referral lancé...")

app.run_polling()
