/**
 * BoostHub — Auth (สมัคร / ล็อกอิน / JWT)
 * ────────────────────────────────────────────────────────────
 * - รหัสผ่าน hash ด้วย bcrypt (ไม่เก็บ plain text)
 * - ออก JWT อายุ 7 วัน หน้าเว็บเก็บ token แล้วแนบมากับทุก request
 *   ผ่าน header  Authorization: Bearer <token>
 * - อย่าเชื่อ userId ที่ client ส่งมา — ดึงจาก token ที่ verify แล้วเท่านั้น
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { users, passwordResets } = require('./db');
const { sendResetCodeEmail } = require('./mailer');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-เปลี่ยนก่อนขึ้น-production';
const TOKEN_TTL = '7d';

function sign(user) {
  return jwt.sign({ uid: user.id, admin: !!user.is_admin }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** ตัดฟิลด์ลับก่อนส่งกลับหน้าเว็บ */
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, credits: u.credits, is_admin: !!u.is_admin, banned: !!u.banned, totp_enabled: !!u.totp_enabled, created_at: u.created_at };
}

async function register({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) throw httpErr(400, 'อีเมลไม่ถูกต้อง');
  if (String(password || '').length < 6) throw httpErr(400, 'รหัสผ่านอย่างน้อย 6 ตัว');
  if (!name) throw httpErr(400, 'กรุณากรอกชื่อ');
  if (users.byEmail(email)) throw httpErr(409, 'อีเมลนี้ถูกใช้แล้ว');

  const password_hash = await bcrypt.hash(password, 10);
  const user = users.create({ email, password_hash, name });
  return { token: sign(user), user: publicUser(user) };
}

async function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const user = users.byEmail(email);
  if (!user) throw httpErr(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw httpErr(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  if (user.banned) throw httpErr(403, 'บัญชีนี้ถูกระงับ');

  // ถ้าเปิด 2FA ไว้ → ยังไม่ออก token เต็ม ต้องยืนยันรหัส 6 หลักก่อน
  if (user.totp_enabled) {
    const tempToken = jwt.sign({ uid: user.id, scope: '2fa' }, JWT_SECRET, { expiresIn: '5m' });
    return { need2fa: true, tempToken };
  }
  return { token: sign(user), user: publicUser(user) };
}

/* ─────────────────── 2FA (Google Authenticator / TOTP) ─────────────────── */

/** ขั้นที่ 2 ของการล็อกอิน — ยืนยันรหัส 6 หลักจากแอป */
function verify2fa({ tempToken, code }) {
  let payload;
  try { payload = jwt.verify(tempToken, JWT_SECRET); }
  catch (e) { throw httpErr(401, 'เซสชันหมดอายุ กรุณาล็อกอินใหม่'); }
  if (payload.scope !== '2fa') throw httpErr(400, 'token ไม่ถูกต้อง');

  const user = users.byId(payload.uid);
  if (!user || !user.totp_enabled || !user.totp_secret) throw httpErr(400, 'บัญชีนี้ไม่ได้เปิด 2FA');
  if (!authenticator.verify({ token: String(code || '').trim(), secret: user.totp_secret }))
    throw httpErr(401, 'รหัส 6 หลักไม่ถูกต้อง');

  return { token: sign(user), user: publicUser(user) };
}

/**
 * เริ่มตั้งค่า 2FA — สร้าง secret (ยังไม่เปิดใช้), คืน QR ให้สแกนด้วย Google Authenticator
 * ต้องยืนยันด้วย enable2fa อีกทีถึงจะเปิดจริง
 */
async function setup2fa(user) {
  // ถ้าเปิด 2FA อยู่แล้ว ห้ามตั้งใหม่ทับ — ไม่งั้น secret เดิมถูกเขียนทับ
  // ทำให้แอป Authenticator เดิมใช้ไม่ได้/ล็อกตัวเองออก ต้องปิด (disable) ก่อน
  if (user.totp_enabled) throw httpErr(400, 'เปิด 2FA อยู่แล้ว — ปิดก่อนถึงจะตั้งใหม่ได้');
  const secret = authenticator.generateSecret();
  users.setTotpSecret(user.id, secret);            // เก็บ pending ไว้ก่อน (ยังไม่ enabled)
  const otpauth = authenticator.keyuri(user.email, 'BoostHub Admin', secret);
  const qrDataUrl = await qrcode.toDataURL(otpauth);
  return { secret, otpauth, qrDataUrl };            // secret = พิมพ์เข้าเองได้ถ้าสแกนไม่ได้
}

/** ยืนยันโค้ดจากแอป → เปิด 2FA จริง */
function enable2fa(user, code) {
  if (!user.totp_secret) throw httpErr(400, 'ยังไม่ได้เริ่มตั้งค่า');
  if (!authenticator.verify({ token: String(code || '').trim(), secret: user.totp_secret }))
    throw httpErr(401, 'รหัส 6 หลักไม่ถูกต้อง ลองใหม่');
  users.setTotpEnabled(user.id, 1);
  return { enabled: true };
}

/** ปิด 2FA — ต้องยืนยันด้วยรหัสผ่านปัจจุบัน */
async function disable2fa(user, password) {
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw httpErr(401, 'รหัสผ่านไม่ถูกต้อง');
  users.setTotpEnabled(user.id, 0);
  users.setTotpSecret(user.id, null);
  return { enabled: false };
}

/* ─────────────────── ลืมรหัสผ่าน (รหัสยืนยัน 6 หลักทางอีเมล) ───────────────────
 * ขั้นตอนมาตรฐาน: ขอรหัส → ระบบส่งรหัส 6 หลักเข้าอีเมลที่สมัคร
 * → กรอกรหัสยืนยัน → ได้ resetToken → ตั้งรหัสผ่านใหม่
 * ⚠️ ไม่มีการคืนรหัส/token กลับหน้าเว็บเด็ดขาด — ต้องเปิดอีเมลจริงเท่านั้น
 * (ถ้ายังไม่ตั้ง SMTP รหัสจะถูกพิมพ์ออก log ของเซิร์ฟเวอร์เท่านั้น)
 */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const RESET_CODE_TTL_MS  = 10 * 60 * 1000;   // รหัส 6 หลักอายุ 10 นาที
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;   // token ตั้งรหัสใหม่ (หลังยืนยันรหัสสำเร็จ) อายุ 15 นาที
const MAX_CODE_ATTEMPTS  = 8;                // เดารหัสผิดได้สูงสุด 8 ครั้งต่อรหัสหนึ่ง
const _codeAttempts = new Map();             // email → จำนวนครั้งที่เดาผิด

/**
 * ขอรีเซ็ต — สุ่มรหัส 6 หลัก เก็บแบบ hash แล้วส่งเข้าอีเมลที่สมัครไว้เท่านั้น
 * ⚠️ ตอบ success เสมอ (ถึงอีเมลไม่มีในระบบ) เพื่อไม่ให้เดาได้ว่าอีเมลไหนมีบัญชี
 */
async function forgotPassword({ email }) {
  email = String(email || '').trim().toLowerCase();
  const user = users.byEmail(email);
  if (user && !user.banned) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
    passwordResets.issue(user.id, sha256('code:' + user.id + ':' + code), expiresAt);   // เก็บแบบ hash เท่านั้น (ขอใหม่ = ของเก่าใช้ไม่ได้)
    _codeAttempts.delete(email);
    try { await sendResetCodeEmail(user.email, code); }
    catch (e) { console.error('ส่งอีเมลรหัสยืนยันล้มเหลว:', e.message); }
  }
  return { ok: true, message: 'ถ้าอีเมลนี้มีบัญชีอยู่ เราได้ส่งรหัสยืนยัน 6 หลักไปให้ทางอีเมลแล้ว' };
}

/** ยืนยันรหัส 6 หลัก → ออก resetToken สำหรับตั้งรหัสผ่านใหม่ (ใช้ครั้งเดียว) */
function verifyResetCode({ email, code }) {
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim();
  if (!/^\d{6}$/.test(code)) throw httpErr(400, 'รหัสยืนยันต้องเป็นตัวเลข 6 หลัก');

  const attempts = (_codeAttempts.get(email) || 0) + 1;
  _codeAttempts.set(email, attempts);
  if (attempts > MAX_CODE_ATTEMPTS) throw httpErr(429, 'ลองผิดหลายครั้งเกินไป กรุณากด "ส่งรหัสอีกครั้ง" เพื่อขอรหัสใหม่');

  const bad = () => httpErr(400, 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุ กรุณาตรวจสอบหรือขอรหัสใหม่');
  const user = users.byEmail(email);
  if (!user || user.banned) throw bad();

  const row = passwordResets.get(sha256('code:' + user.id + ':' + code));
  if (!row || row.used || row.user_id !== user.id) throw bad();
  if (new Date(row.expires_at).getTime() < Date.now()) throw httpErr(400, 'รหัสหมดอายุแล้ว กรุณาขอรหัสใหม่');

  // รหัสถูกต้อง → ออก token สำหรับตั้งรหัสใหม่ (issue จะล้างรหัสเก่าทิ้งให้เอง — ใช้ซ้ำไม่ได้)
  const token = crypto.randomBytes(32).toString('hex');
  passwordResets.issue(user.id, sha256(token), new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString());
  _codeAttempts.delete(email);
  return { ok: true, resetToken: token };
}

/** ตั้งรหัสใหม่ด้วย resetToken (จาก verifyResetCode) — ใช้ครั้งเดียว */
async function resetPassword({ token, password }) {
  if (!token) throw httpErr(400, 'เซสชันไม่ถูกต้อง กรุณาเริ่มขั้นตอนลืมรหัสผ่านใหม่');
  if (String(password || '').length < 6) throw httpErr(400, 'รหัสผ่านอย่างน้อย 6 ตัว');

  const row = passwordResets.get(sha256(String(token)));
  if (!row || row.used) throw httpErr(400, 'เซสชันหมดอายุ กรุณาเริ่มขั้นตอนลืมรหัสผ่านใหม่');
  if (new Date(row.expires_at).getTime() < Date.now()) throw httpErr(400, 'เซสชันหมดอายุ กรุณาเริ่มขั้นตอนลืมรหัสผ่านใหม่');

  const hash = await bcrypt.hash(String(password), 10);
  users.setPassword(row.user_id, hash);
  passwordResets.markUsed(sha256(String(token)));
  passwordResets.clearForUser(row.user_id);     // ล้าง token อื่น ๆ ของ user นี้ทั้งหมด

  const user = users.byId(row.user_id);
  return { token: sign(user), user: publicUser(user) };   // ล็อกอินให้เลยหลังตั้งรหัสใหม่
}

/* ─────────────────── เข้าสู่ระบบด้วย Google (Gmail) ─────────────────── */
async function loginWithGoogle({ credential }) {
  if (!credential) throw httpErr(400, 'ไม่พบข้อมูลจาก Google');
  let payload;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(credential)));
    payload = await r.json();
    if (!r.ok || payload.error) throw new Error('bad token');
  } catch (e) { throw httpErr(401, 'ยืนยันบัญชี Google ไม่สำเร็จ'); }
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (clientId && payload.aud !== clientId) throw httpErr(401, 'บัญชี Google ไม่ตรงกับแอปนี้');
  if (!payload.email || payload.email_verified === false || payload.email_verified === 'false')
    throw httpErr(401, 'อีเมล Google นี้ยังไม่ได้ยืนยัน');
  const email = String(payload.email).trim().toLowerCase();
  let user = users.byEmail(email);
  if (!user) {
    const randomHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    user = users.create({ email, password_hash: randomHash, name: payload.name || email.split('@')[0] });
  }
  if (user.banned) throw httpErr(403, 'บัญชีนี้ถูกระงับ');
  return { token: sign(user), user: publicUser(user) };
}

/* ─────────────────── middleware ─────────────────── */

/** ต้องล็อกอิน — แนบ req.user (จาก DB) ให้ route ถัดไป */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบ' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.byId(payload.uid);
    if (!user) return res.status(401).json({ error: 'ผู้ใช้ไม่มีอยู่' });
    if (user.banned) return res.status(403).json({ error: 'บัญชีถูกระงับ' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

/** ต้องเป็นแอดมิน (ใช้ต่อจาก requireAuth) */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'เฉพาะแอดมิน' });
  next();
}

/**
 * auth แบบไม่บังคับ — ถ้ามี token ที่ถูกต้องก็แนบ req.user ให้ ถ้าไม่มีก็ปล่อยผ่าน
 * ใช้กับ endpoint เติมเงิน: ลูกค้าที่ล็อกอินแล้วจะผูกเครดิตกับบัญชีจริง
 * ส่วนลูกค้าที่ยังไม่ได้ต่อระบบล็อกอิน (guest) ยังจ่ายเงินได้ตามเดิม
 */
function optionalAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      const u = users.byId(p.uid);
      if (u && !u.banned) req.user = u;
    } catch (e) { /* token ไม่ดี → ถือเป็น guest */ }
  }
  next();
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { register, login, forgotPassword, verifyResetCode, resetPassword, verify2fa, setup2fa, enable2fa, disable2fa, requireAuth, requireAdmin, optionalAuth, publicUser, sign, httpErr, loginWithGoogle };
