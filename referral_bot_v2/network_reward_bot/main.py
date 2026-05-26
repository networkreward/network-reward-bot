from telegram import Update from telegram.ext 
import ApplicationBuilder, CommandHandler, 
ContextTypes TOKEN = 
"8844630275:AAFc2lwkSN6XfRUGRI0WjJvhfbAOZSomr9E" 
BOT_USERNAME = "network_reward_bot" async def 
start(update: Update, context: 
ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id link = 
    f"https://t.me/{BOT_USERNAME}?start={user_id}" 
    await update.message.reply_text(
        "🚀 Bienvenue !\n\n" f"🔗 Ton lien 
        :\n{link}"
    ) app = 
ApplicationBuilder().token(TOKEN).build() 
app.add_handler(CommandHandler("start", start)) 
print("Bot lancé...")
app.run_polling()
nano main.py

