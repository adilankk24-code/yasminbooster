/**
 * BoostHub — ตัวส่งอีเมล (nodemailer)
 * ────────────────────────────────────────────────────────────
 * ตั้งค่า SMTP ใน .env (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM)
 * ถ้ายังไม่ได้ตั้ง → โหมด dev: พิมพ์ลิงก์รีเซ็ตออก console ให้เทสได้เลย
 *
 * แนะนำผู้ให้บริการที่ตั้งง่าย: Resend, Brevo, Mailgun, Gmail SMTP
 */
const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,     // 465 = SSL
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const MAIL_FROM = process.env.MAIL_FROM || 'BoostHub <no-reply@boosthub.local>';

/** ส่งรหัสยืนยัน 6 หลักสำหรับรีเซ็ตรหัสผ่าน (หมดอายุ 10 นาที) */
async function sendResetCodeEmail(to, code) {
  const subject = `${code} คือรหัสยืนยันของคุณ — รีเซ็ตรหัสผ่าน`;
  const text = `มีการขอรีเซ็ตรหัสผ่านสำหรับบัญชีนี้\n\nรหัสยืนยันของคุณคือ: ${code}\n(หมดอายุใน 10 นาที ใช้ได้ครั้งเดียว)\n\nถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย`;
  const html = `
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a2e">
      <h2 style="margin:0 0 8px;font-size:20px">รหัสยืนยันรีเซ็ตรหัสผ่าน</h2>
      <p style="color:#555;line-height:1.6;font-size:14px">มีการขอรีเซ็ตรหัสผ่านสำหรับบัญชีนี้ นำรหัสด้านล่างไปกรอกในหน้าเว็บเพื่อยืนยันตัวตน</p>
      <div style="margin:20px 0;padding:18px;background:#f4f1ff;border:1px solid #e0d8ff;border-radius:12px;text-align:center">
        <div style="font-size:34px;font-weight:800;letter-spacing:.35em;color:#5b3df0;font-family:Consolas,monospace">${code}</div>
        <div style="font-size:12px;color:#999;margin-top:6px">หมดอายุใน 10 นาที · ใช้ได้ครั้งเดียว</div>
      </div>
      <p style="color:#bbb;font-size:12px">ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย และอย่าบอกรหัสนี้กับใคร</p>
    </div>`;

  if (!transport) {
    console.log('\n──────── 📧 [DEV] ยังไม่ได้ตั้งค่า SMTP — รหัสยืนยันสำหรับ', to, '────────');
    console.log('รหัส:', code);
    console.log('────────────────────────────────────────────────────────────\n');
    return { dev: true };
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

async function sendResetEmail(to, link) {
  const subject = 'รีเซ็ตรหัสผ่าน BoostHub';
  const text = `มีการขอรีเซ็ตรหัสผ่านสำหรับบัญชีนี้\n\nกดลิงก์นี้เพื่อตั้งรหัสผ่านใหม่ (หมดอายุใน 1 ชั่วโมง):\n${link}\n\nถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย`;
  const html = `
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a2e">
      <h2 style="margin:0 0 8px;font-size:20px">รีเซ็ตรหัสผ่าน</h2>
      <p style="color:#555;line-height:1.6;font-size:14px">มีการขอรีเซ็ตรหัสผ่านสำหรับบัญชีนี้ กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่ ลิงก์นี้ใช้ได้ครั้งเดียวและหมดอายุใน 1 ชั่วโมง</p>
      <a href="${link}" style="display:inline-block;margin:18px 0;padding:13px 26px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px">ตั้งรหัสผ่านใหม่</a>
      <p style="color:#999;font-size:12px;line-height:1.6">ถ้าปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์:<br><span style="color:#7c5cff;word-break:break-all">${link}</span></p>
      <p style="color:#bbb;font-size:12px;margin-top:20px">ถ้าคุณไม่ได้เป็นคนขอ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย</p>
    </div>`;

  if (!transport) {
    console.log('\n──────── 📧 [DEV] ยังไม่ได้ตั้งค่า SMTP — ลิงก์รีเซ็ตสำหรับ', to, '────────');
    console.log(link);
    console.log('────────────────────────────────────────────────────────────\n');
    return { dev: true };
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

module.exports = { sendResetEmail, sendResetCodeEmail };
