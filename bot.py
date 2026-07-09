# -*- coding: utf-8 -*-
# ============================================================
#  PumpDesk — Telegram Bot
#  พิมพ์ /order ในแชต -> เด้งฟอร์ม Mini App ให้ใส่ออเดอร์
#  กดบันทึกในฟอร์ม -> บอทส่งสรุปออเดอร์กลับเข้าแชต
# ============================================================
#
#  วิธีติดตั้ง (ทำครั้งเดียว):
#    1) ติดตั้ง Python 3.10+  แล้วรัน:
#         pip install "python-telegram-bot==21.*"
#    2) ขอ Bot Token จาก @BotFather  (/newbot) เอามาใส่ที่ BOT_TOKEN
#    3) เผยแพร่ไฟล์ "order.html" ให้เป็นลิ้ง https:// (ต้องเป็น https เท่านั้น)
#       เอา URL นั้นมาใส่ที่ WEBAPP_URL
#    4) รัน:  python bot.py
#
#  หมายเหตุสำคัญเรื่องการส่งข้อมูลกลับ:
#    - Telegram อนุญาตให้ Mini App "ส่งข้อมูลกลับบอท" (sendData) ได้
#      เฉพาะเมื่อเปิดจาก "ปุ่มคีย์บอร์ด" (reply keyboard) เท่านั้น
#      สคริปต์นี้จึงตอบ /order ด้วยปุ่มคีย์บอร์ดแบบ web_app ให้อัตโนมัติ
# ============================================================

import json
from telegram import (
    Update,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    WebAppInfo,
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ====== ตั้งค่าตรงนี้ ======
BOT_TOKEN = "ใส่_BOT_TOKEN_ของคุณที่นี่"
WEBAPP_URL = "https://ใส่โดเมนของคุณ/order.html?shop=ชื่อร้านของคุณ"
# ==========================


async def order(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/order -> แสดงปุ่มเปิดฟอร์มใส่ออเดอร์"""
    keyboard = ReplyKeyboardMarkup.from_button(
        KeyboardButton(
            text="➕ เปิดฟอร์มใส่ออเดอร์",
            web_app=WebAppInfo(url=WEBAPP_URL),
        ),
        resize_keyboard=True,
    )
    await update.message.reply_text(
        "แตะปุ่มด้านล่างเพื่อเปิดฟอร์มใส่ออเดอร์ 👇",
        reply_markup=keyboard,
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "สวัสดีครับ 🚀 พิมพ์ /order เพื่อเปิดฟอร์มใส่ออเดอร์เข้า PumpDesk"
    )


async def web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """รับข้อมูลออเดอร์ที่ฟอร์มส่งกลับมา แล้วสรุปเข้าแชต"""
    raw = update.effective_message.web_app_data.data
    try:
        payload = json.loads(raw)
        o = payload.get("order", payload)
    except Exception:
        await update.message.reply_text("⚠️ อ่านข้อมูลออเดอร์ไม่ได้")
        return

    def fmt(n):
        try:
            return f"{int(n):,}"
        except Exception:
            return str(n or "-")

    text = (
        "✅ <b>บันทึกออเดอร์แล้ว</b>\n\n"
        f"⚡ บริการ: {o.get('platform','-')} — {o.get('service','-')}\n"
        f"🧾 แอคเค้า: {o.get('accountType','ปกติปน')}\n"
        f"🔢 ยอดสั่ง: {fmt(o.get('qty'))}\n"
        f"💰 ราคา: ฿{fmt(o.get('price'))}\n"
        f"🔗 {o.get('link') or '-'}\n"
        f"🗓️ {o.get('date','-')}"
    )
    await update.message.reply_text(
        text, parse_mode="HTML", reply_markup=ReplyKeyboardRemove()
    )

    # >>> จุดนี้คือที่คุณจะบันทึกลงฐานข้อมูลจริง / ยิงเข้า API เว็บของคุณ <<<
    # เช่น: requests.post("https://your-api/orders", json=o)
    print("ออเดอร์ใหม่:", o)


def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("order", order))
    app.add_handler(
        MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data)
    )
    print("บอทกำลังทำงาน... กด Ctrl+C เพื่อหยุด")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
