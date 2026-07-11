# คู่มือ Deploy ขึ้น Render (ทีละขั้น)

สถาปัตยกรรม: 2 services บน Render (ตาม `render.yaml`)
- **ym-booster-api** (Node) → หลังบ้าน + ฐานข้อมูล + Stripe  → `https://ym-booster-api.onrender.com`
- **ym-booster-web** (Static) → หน้าเว็บลูกค้า `/` + แอดมิน `/admin`

> ⚠️ ชื่อ service `ym-booster-api` **ต้องตรง** เพราะหน้าเว็บฝัง URL นี้ไว้แล้ว (พร็อพ `stripeBackendUrl`)
> ถ้า Render เติม suffix ให้ (ชื่อซ้ำในระบบ) → URL จะเปลี่ยน ต้องแก้พร็อพแล้ว build ใหม่ (ดูภาคผนวก A)

---

## ✅ สิ่งที่เตรียมให้แล้ว (ไม่ต้องทำ)
- รีวิว + แก้บั๊ก/ช่องโหว่หลังบ้านเรียบร้อย
- `render.yaml` ตั้งชื่อ service ให้ตรงกับหน้าเว็บ
- Bundle หน้าเว็บใหม่ลง `site/index.html` + `site/admin.html` (มีของที่แก้วันนี้)
- ก็อปไอคอน/โลโก้เข้า `site/assets/` แล้ว (ไม่งั้นจะ 404 บน static host)

---

## ขั้นที่ 0 — เอาโปรเจกต์ขึ้น GitHub
Render Blueprint อ่านจาก Git repo
1. สร้าง repo ใหม่บน GitHub (private ได้)
2. ดาวน์โหลดโปรเจกต์นี้ → push ขึ้น repo นั้น (ต้องมี `render.yaml`, โฟลเดอร์ `backend/`, `site/` ครบ)

## ขั้นที่ 1 — เตรียมคีย์ Stripe (ทำก่อน deploy)
1. สมัคร/เข้า https://dashboard.stripe.com
2. **แนะนำเริ่มด้วยโหมด Test ก่อน** (สลับ Live ทีหลัง)
3. Developers → API keys → คัดลอก
   - `Publishable key` (`pk_test_...`)
   - `Secret key` (`sk_test_...`)
4. เปิด PromptPay: Settings → Payment methods → เปิด **PromptPay** (ต้องเป็นบัญชี Stripe ไทย)

## ขั้นที่ 2 — สร้าง Webhook ใน Stripe (ทำ "ก่อน" deploy)
> ทำก่อนเพราะหลังบ้านโหมด production จะ **ไม่ start** ถ้าไม่มี `STRIPE_WEBHOOK_SECRET`
> Stripe ให้สร้าง endpoint ชี้ไป URL ที่ยังไม่ขึ้นได้ทันที (ยังไม่เช็คว่า live)
1. Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://ym-booster-api.onrender.com/api/webhook`
3. Events to send: เลือก **`payment_intent.succeeded`**
4. Add endpoint → คัดลอก **Signing secret** (`whsec_...`) เก็บไว้

## ขั้นที่ 3 — Deploy ด้วย Render Blueprint
1. เข้า https://dashboard.render.com → **New → Blueprint**
2. เลือก repo ที่ push ไว้ → Render อ่าน `render.yaml` เอง เห็น 2 services
3. ก่อนกด Apply จะให้กรอก env ที่ตั้ง `sync: false` — กรอกให้ครบ:

**ym-booster-api (หลังบ้าน):**
| Key | ค่า |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (จากขั้น 1) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (จากขั้น 2) |
| `FRONTEND_ORIGIN` | `https://ym-booster-web.onrender.com` |
| `FRONTEND_URL` | `https://ym-booster-web.onrender.com` |
| `ADMIN_EMAIL` | อีเมลแอดมินของคุณ |
| `ADMIN_PASSWORD` | รหัสแอดมินที่แข็งแรง |

> `JWT_SECRET` Render สุ่มให้เอง / `DB_PATH=/data/boosthub.db` ตั้งไว้แล้วใน yaml
> Persistent Disk 1GB ที่ `/data` → ข้อมูลไม่หายเวลา deploy (plan ต้อง **Starter** ขึ้นไป)

4. กด **Apply** → รอ build (2–4 นาที)
5. เช็คว่าขึ้น: เปิด `https://ym-booster-api.onrender.com/api/health` → ต้องเห็น `{"ok":true}`

## ขั้นที่ 4 — ตรวจว่าหน้าเว็บต่อหลังบ้านติด
1. เปิด `https://ym-booster-web.onrender.com`
2. **สมัครสมาชิก** ด้วยอีเมลจริง → ต้องเข้าแอปได้ (ถ้าเด้ง error CORS = `FRONTEND_ORIGIN` ไม่ตรง)
3. เข้า `https://ym-booster-web.onrender.com/admin` → ล็อกอินด้วย `ADMIN_EMAIL`/`ADMIN_PASSWORD`
   → **เปลี่ยนรหัสแอดมิน + เปิด 2FA ทันที**

## ขั้นที่ 5 — ทดสอบเงินเข้า (Stripe test)
1. หน้าเว็บ → เติมเงิน → พร้อมเพย์/บัตร
2. ใช้บัตรทดสอบ Stripe: `4242 4242 4242 4242` วันหมดอายุอนาคต CVC อะไรก็ได้
3. จ่ายสำเร็จ → Stripe ยิง webhook → เครดิตเข้าอัตโนมัติ (เช็คใน Stripe → Webhooks → มี 200)
4. ลอง **สั่งซื้อบริการ** → เครดิตถูกตัด → เห็นออเดอร์ในหน้าแอดมิน

## ขั้นที่ 6 — สลับเป็น Live (เปิดจริง)
1. Stripe สลับเป็น **Live mode** → เอา `pk_live_` / `sk_live_` มาแทน
2. สร้าง Webhook ใหม่ในโหมด Live → เอา `whsec_` ใหม่มาใส่
3. อัปเดต env ทั้ง 3 ค่าบน Render → service จะ redeploy เอง
4. (แนะนำ) ตั้งโดเมนจริงใน Render → อัปเดต `FRONTEND_ORIGIN`/`FRONTEND_URL` เป็นโดเมนนั้น

---

## ภาคผนวก A — ถ้า URL หลังบ้านไม่ใช่ ym-booster-api.onrender.com
เกิดเมื่อชื่อซ้ำแล้ว Render เติม suffix ให้ ต้องชี้หน้าเว็บไปที่ URL ใหม่:
1. บอกผม URL จริง → ผมแก้พร็อพ `stripeBackendUrl` ในหน้าเว็บ + admin
2. ผม build `site/` ใหม่ → push → static redeploy

## ภาคผนวก B — สิ่งที่ยังทำเองไม่ได้ (เฟสถัดไป)
- **ต่อซัพพลายเออร์ SMM จริง** ✅ *โค้ดพร้อมแล้ว* — รองรับหลายเจ้าพร้อมกัน + เลือกเจ้าถูกสุด + fallback + sync สถานะอัตโนมัติ
  เหลือแค่คุณ **กรอกคีย์เจ้า + จับคู่บริการ** (ทำครั้งเดียว):
  1. บน Render → ym-booster-api → Environment → กรอก `PROVIDER_A_NAME` / `PROVIDER_A_URL` / `PROVIDER_A_KEY`
     (เพิ่มเจ้า B, C → เพิ่ม `PROVIDER_B_URL`+`PROVIDER_B_KEY`, `PROVIDER_C_...` ตามรูปแบบเดิม) → service redeploy เอง
  2. เช็คว่าติด: เปิด `/api/health` → ต้องเห็น `providers:[{key,name}...]` ครบทุกเจ้า
  3. เข้าแอดมิน → แท็บ **ซัพพลายเออร์** → เห็นการ์ดเครดิตแต่ละเจ้า → จับคู่บริการ (บริการไหน → เจ้าไหน + เลข service ของเจ้านั้น) แล้วกดบันทึก
  4. เสร็จ — ลูกค้าสั่งปุ๊บ ระบบยิงออเดอร์ไปเจ้าที่ตั้งไว้อัตโนมัติ + คืนเครดิตให้เองถ้าเจ้าปฏิเสธ
- **อีเมล**: ตั้ง `SMTP_*` เพื่อให้ "ลืมรหัสผ่าน" ส่งรหัสยืนยัน 6 หลักเข้าอีเมลจริง (ไม่ตั้ง = รหัสพิมพ์ออก log ของเซิร์ฟเวอร์เท่านั้น ลูกค้ารีเซ็ตเองไม่ได้)
- **ล็อกอิน Google**: ตั้ง `GOOGLE_CLIENT_ID` บน service หลังบ้าน — หน้าเว็บดึงจาก `/api/config` อัตโนมัติ ปุ่ม "Continue with Google" จะโผล่เอง
- **ยังเป็นทางเลือก (ยังไม่ได้ทำ — บอกได้ถ้าต้องการ)**: เช็คสลิปอัตโนมัติ (SlipOK/EasySlip), แจ้งเตือน LINE, คูปอง/โปรโมชั่น, ระบบแนะนำเพื่อน (affiliate)

## ภาคผนวก C — เช็กลิสต์ความปลอดภัยก่อนเปิดจริง
- [ ] เปลี่ยน `ADMIN_PASSWORD` จาก default + เปิด 2FA
- [ ] `FRONTEND_ORIGIN` เป็นโดเมนจริง (ไม่ใช่ `*`)
- [ ] `STRIPE_WEBHOOK_SECRET` เป็นของโหมด Live
- [ ] ยืนยันดิสก์ `/data` mount แล้ว (ข้อมูลไม่หายหลัง redeploy — ลองสมัคร แล้ว Manual Deploy ซ้ำ เช็คว่าบัญชียังอยู่)
