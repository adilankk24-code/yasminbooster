/**
 * BoostHub — Multi-provider layer (ต่อซัพพลายเออร์ SMM หลายเจ้าพร้อมกัน)
 * ────────────────────────────────────────────────────────────
 * เกือบทุก panel SMM ใช้ "SMM Panel API v2" มาตรฐานเดียวกัน:
 *   POST (application/x-www-form-urlencoded) ไป api_url เดียว ส่ง key + action
 *     action=services  → รายการบริการ + เรตต้นทุน
 *     action=add       → สั่งออเดอร์ {service, link, quantity} → คืน {order}
 *     action=status    → สถานะออเดอร์ {order} → {charge,start_count,status,remains}
 *     action=balance   → เครดิตคงเหลือของบัญชีเรากับเจ้านั้น
 *
 * ไฟล์นี้:
 *   • โหลด "หลายเจ้า" จาก .env (แต่ละเจ้ามี url + key ของตัวเอง)
 *   • ตาราง service_map (ใน DB) จับคู่ บริการของเรา → เจ้าไหน + service id ของเจ้านั้น
 *   • routing: ใช้เจ้าที่ map ไว้ (manual) หรือเลือกเจ้าถูกสุด (auto-cheapest)
 *   • fallback: เจ้าแรก error/หมดสต๊อก → ลองเจ้าถัดไปอัตโนมัติ
 *
 * ⚠️ API key = กุญแจกระเป๋าเงินเรากับซัพพลายเออร์ — อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
 *    ทุก endpoint ที่คืนข้อมูล provider จะไม่ส่ง apiKey ออกไปเด็ดขาด (ดู listProviders)
 */
const { db } = require('./db');

/* ───────────────────────── migration (เพิ่มของให้ DB เดิม) ─────────────────────────
 * ทำแบบ additive เหมือน pattern 2FA ใน db.js — รันซ้ำได้ ไม่พังของเก่า
 */
const _orderCols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
const addCol = (name, ddl) => { if (!_orderCols.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${ddl}`); };
addCol('provider_key',    `provider_key TEXT`);          // เจ้าที่ส่งออเดอร์นี้ไป (A/B/…)
addCol('provider_status', `provider_status TEXT`);        // สถานะดิบจากเจ้านั้น (Pending/In progress/Completed/Partial/Canceled)
addCol('provider_charge', `provider_charge REAL`);        // ต้นทุนจริงที่เจ้านั้นคิด (สกุลของเขา)
addCol('start_count',     `start_count INTEGER`);         // ยอดตั้งต้นตอนเริ่มปั่น
addCol('remains',         `remains INTEGER`);             // ยอดที่ยังค้างส่ง
// provider_id (id ออเดอร์ฝั่งซัพพลายเออร์) มีอยู่แล้วใน schema เดิม — ใช้ต่อได้เลย

db.exec(`
  CREATE TABLE IF NOT EXISTS service_map (
    my_key           TEXT PRIMARY KEY,   -- 'tiktok/tt_follow'  (platform '/' serviceId)
    provider_key     TEXT,               -- เจ้าที่จะใช้ (A/B/…) — ว่าง = auto-cheapest
    provider_service TEXT,               -- service id ฝั่งเจ้านั้น (เช่น '5521')
    mode             TEXT NOT NULL DEFAULT 'manual',  -- manual | auto
    updated_at       TEXT
  );
`);

const _getMap  = db.prepare(`SELECT * FROM service_map WHERE my_key = ?`);
const _allMap  = db.prepare(`SELECT * FROM service_map`);
const _upMap   = db.prepare(
  `INSERT INTO service_map (my_key,provider_key,provider_service,mode,updated_at)
   VALUES (@my_key,@provider_key,@provider_service,@mode,@updated_at)
   ON CONFLICT(my_key) DO UPDATE SET
     provider_key=@provider_key, provider_service=@provider_service, mode=@mode, updated_at=@updated_at`
);
const _setOrderProvider = db.prepare(
  `UPDATE orders SET provider_key=@provider_key, provider_id=@provider_id, provider_status=@provider_status,
     provider_charge=@provider_charge, start_count=@start_count, remains=@remains WHERE id=@id`
);
const _liveOrders = db.prepare(
  `SELECT * FROM orders WHERE provider_id IS NOT NULL AND status NOT IN ('เสร็จสิ้น','ยกเลิก')`
);

/* ───────────────────────── โหลดซัพพลายเออร์จาก .env ─────────────────────────
 * รูปแบบ (เพิ่มกี่เจ้าก็ได้ — A, B, C, …):
 *   PROVIDER_A_NAME=ชื่อร้าน (โชว์ในแอดมิน)
 *   PROVIDER_A_URL=https://xxx/api/v2
 *   PROVIDER_A_KEY=คีย์ของบัญชีเรากับเจ้านั้น
 *   PROVIDER_A_CURRENCY=USD           (ไม่ใส่ก็ได้ — แค่ป้ายกำกับ)
 *   PROVIDER_A_RATE_TO_CREDIT=35      (ต้นทุน 1 หน่วยสกุลเขา = กี่เครดิตของเรา — ไว้เทียบราคา auto)
 */
function loadProviders() {
  const out = {};
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^PROVIDER_([A-Z0-9]+)_URL$/);
    if (!m) continue;
    const id = m[1];
    const url = String(process.env[`PROVIDER_${id}_URL`] || '').trim();
    const apiKey = String(process.env[`PROVIDER_${id}_KEY`] || '').trim();
    if (!url || !apiKey) continue;   // ต้องมีทั้ง url + key ถึงนับว่าเจ้านี้พร้อมใช้
    out[id] = {
      key: id,
      name: (process.env[`PROVIDER_${id}_NAME`] || `ซัพพลายเออร์ ${id}`).trim(),
      url,
      apiKey,
      currency: (process.env[`PROVIDER_${id}_CURRENCY`] || '').trim() || null,
      rateToCredit: Number(process.env[`PROVIDER_${id}_RATE_TO_CREDIT`]) || null,
    };
  }
  return out;
}
let PROVIDERS = loadProviders();
const reloadProviders = () => (PROVIDERS = loadProviders());
const hasProviders = () => Object.keys(PROVIDERS).length > 0;

/* ───────────────────────── ตัวยิง API มาตรฐาน v2 ───────────────────────── */
async function call(p, params, { timeoutMs = 20000 } = {}) {
  const body = new URLSearchParams({ key: p.apiKey, ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${p.name}: หมดเวลาเชื่อมต่อ` : `${p.name}: เชื่อมต่อไม่ได้ (${e.message})`);
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${p.name}: ตอบกลับไม่ใช่ JSON — ${text.slice(0, 160)}`); }
  // มาตรฐาน v2: ถ้าพลาดจะมี field "error"
  if (json && json.error) throw new Error(`${p.name}: ${json.error}`);
  return json;
}

const api = {
  services: (p) => call(p, { action: 'services' }, { timeoutMs: 30000 }),
  balance:  (p) => call(p, { action: 'balance' }),
  add:      (p, { service, link, quantity, extra = {} }) =>
    call(p, { action: 'add', service, link, quantity, ...extra }),
  status:   (p, order) => call(p, { action: 'status', order }),
};

/* ───────────────────────── cache รายการบริการ (ไว้เทียบราคา auto) ─────────────────────────
 * ดึง services ของแต่ละเจ้ามาเก็บ 10 นาที — auto-cheapest จะอ่านจากนี่ ไม่ยิงซ้ำทุกออเดอร์
 */
const _svcCache = new Map();   // providerKey → { at, list }
async function getServices(providerKey, { force = false } = {}) {
  const p = PROVIDERS[providerKey];
  if (!p) throw new Error('ไม่พบซัพพลายเออร์ ' + providerKey);
  const c = _svcCache.get(providerKey);
  if (!force && c && Date.now() - c.at < 10 * 60 * 1000) return c.list;
  const list = await api.services(p);
  const arr = Array.isArray(list) ? list : [];
  _svcCache.set(providerKey, { at: Date.now(), list: arr });
  return arr;
}

/* ───────────────────────── service map (จับคู่บริการเรา → เจ้า) ───────────────────────── */
const mapKey = (platform, serviceId) => `${platform}/${serviceId}`;
const serviceMap = {
  get: (platform, serviceId) => _getMap.get(mapKey(platform, serviceId)) || null,
  all: () => _allMap.all(),
  set({ platform, serviceId, providerKey = null, providerService = null, mode = 'manual' }) {
    _upMap.run({
      my_key: mapKey(platform, serviceId),
      provider_key: providerKey || null,
      provider_service: providerService ? String(providerService) : null,
      mode,
      updated_at: new Date().toISOString(),
    });
    return _getMap.get(mapKey(platform, serviceId));
  },
};

/**
 * เลือกลำดับเจ้าที่จะลองส่งออเดอร์นี้ — คืน array ของ {providerKey, providerService}
 *   • mode=manual + map ครบ → ใช้เจ้านั้นก่อน แล้วต่อด้วยเจ้าที่เหลือเป็น fallback (ถ้ามี providerService เดียวกันข้ามเจ้าไม่ได้ จึง fallback เฉพาะเจ้าที่ map ตัวเดียว)
 *   • mode=auto → เรียงเจ้าถูกสุดก่อน โดยดูจาก rate ใน services cache × RATE_TO_CREDIT
 * ไม่มี provider เลย / ไม่มี map → คืน [] (คงพฤติกรรมเดิม: แอดมินทำมือ)
 */
async function resolveRoute(platform, serviceId) {
  if (!hasProviders()) return [];
  const m = serviceMap.get(platform, serviceId);

  // ── manual: map ชี้เจ้า + service ตรง ๆ ──
  if (m && m.mode !== 'auto' && m.provider_key && m.provider_service) {
    if (!PROVIDERS[m.provider_key]) return [];   // เจ้าที่ map ถูกถอดออกจาก env แล้ว
    return [{ providerKey: m.provider_key, providerService: m.provider_service }];
  }

  // ── auto-cheapest: ต้องรู้ว่า service ของเราตรงกับ service id ไหนในแต่ละเจ้า ──
  // ใช้ตาราง auto-map (คั่นด้วย ';' ใน .env) เพราะเลข service ของแต่ละเจ้าไม่เท่ากัน:
  //   PROVIDER_A_MAP=tiktok/tt_follow:5521,instagram/ig_like:330
  const candidates = [];
  for (const pk of Object.keys(PROVIDERS)) {
    const svcId = envAutoMap(pk, platform, serviceId);
    if (!svcId) continue;
    let cost = Infinity;
    try {
      const list = await getServices(pk);
      const found = list.find((s) => String(s.service) === String(svcId));
      if (found) {
        const rate = Number(found.rate);   // ต้นทุนต่อ 1,000 (สกุลของเขา)
        const toCredit = PROVIDERS[pk].rateToCredit || 1;
        if (Number.isFinite(rate)) cost = rate * toCredit;
      }
    } catch { /* เจ้านี้ดึง services ไม่ได้ → ให้อยู่ท้ายแถว */ }
    candidates.push({ providerKey: pk, providerService: svcId, cost });
  }
  candidates.sort((a, b) => a.cost - b.cost);   // ถูกสุดก่อน (เจ้าที่ดึงราคาไม่ได้ cost=Infinity อยู่ท้าย = fallback)
  return candidates.map(({ providerKey, providerService }) => ({ providerKey, providerService }));
}

// อ่าน auto-map จาก env: PROVIDER_A_MAP=tiktok/tt_follow:5521,instagram/ig_like:330
function envAutoMap(providerKey, platform, serviceId) {
  const raw = process.env[`PROVIDER_${providerKey}_MAP`];
  if (!raw) return null;
  const want = mapKey(platform, serviceId);
  for (const pair of raw.split(',')) {
    const i = pair.lastIndexOf(':');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === want) return pair.slice(i + 1).trim();
  }
  return null;
}

/* ───────────────────────── ส่งออเดอร์ไปซัพพลายเออร์ (มี fallback) ─────────────────────────
 * คืน { providerKey, providerOrderId, providerName } ถ้าสำเร็จ
 * โยน error ถ้าลองทุกเจ้าแล้วไม่ผ่าน (ให้ผู้เรียกไปคืนเครดิต)
 */
async function dispatch({ platform, serviceId, link, quantity }) {
  const route = await resolveRoute(platform, serviceId);
  if (route.length === 0) return null;   // ไม่ได้ตั้ง provider/map → คงพฤติกรรมเดิม (ทำมือ)

  const errors = [];
  for (const hop of route) {
    const p = PROVIDERS[hop.providerKey];
    if (!p) continue;
    try {
      const r = await api.add(p, { service: hop.providerService, link, quantity });
      const orderId = r && (r.order ?? r.id);
      if (orderId == null) throw new Error('ไม่ได้รับเลขออเดอร์กลับมา');
      return { providerKey: hop.providerKey, providerName: p.name, providerOrderId: String(orderId) };
    } catch (e) {
      errors.push(e.message);   // เจ้านี้พลาด → ลองเจ้าถัดไป
    }
  }
  throw new Error('ส่งออเดอร์ไม่สำเร็จทุกเจ้า: ' + errors.join(' | '));
}

// map สถานะดิบของซัพพลายเออร์ → สถานะภาษาไทยที่หน้าเว็บ/แอดมินใช้
function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('complet')) return 'เสร็จสิ้น';
  if (s.includes('partial')) return 'สำเร็จบางส่วน';
  if (s.includes('cancel') || s.includes('refund')) return 'ยกเลิก';
  if (s.includes('progress') || s.includes('processing')) return 'กำลังดำเนินการ';
  return 'รอดำเนินการ';
}

/* ───────────────────────── ผูกผล dispatch ลงออเดอร์ใน DB ───────────────────────── */
function attachToOrder(orderId, dispatched) {
  _setOrderProvider.run({
    id: orderId,
    provider_key: dispatched.providerKey,
    provider_id: dispatched.providerOrderId,
    provider_status: 'Pending',
    provider_charge: null,
    start_count: null,
    remains: null,
  });
}

/* ───────────────────────── sync สถานะออเดอร์ที่ยังไม่จบ ─────────────────────────
 * เรียกเป็นระยะ (poller) หรือแอดมินกดเอง — อัปเดต progress + สถานะจากเจ้าจริง
 */
const { orders } = require('./db');
async function syncOrder(o) {
  const p = PROVIDERS[o.provider_key];
  if (!p || !o.provider_id) return null;
  const r = await api.status(p, o.provider_id);
  const status = mapStatus(r.status);
  const remains = Number(r.remains);
  const start = Number(r.start_count);
  // progress % = (ส่งไปแล้ว / จำนวนที่สั่ง) จาก remains
  let progress = o.progress;
  if (Number.isFinite(remains) && o.qty > 0) progress = Math.max(0, Math.min(100, Math.round((1 - remains / o.qty) * 100)));
  if (status === 'เสร็จสิ้น') progress = 100;
  _setOrderProvider.run({
    id: o.id,
    provider_key: o.provider_key,
    provider_id: o.provider_id,
    provider_status: r.status || o.provider_status,
    provider_charge: Number(r.charge) || o.provider_charge,
    start_count: Number.isFinite(start) ? start : o.start_count,
    remains: Number.isFinite(remains) ? remains : o.remains,
  });
  orders.setStatus(o.id, status, progress);
  return { status, progress, raw: r };
}

// วนเช็คทุกออเดอร์ที่ยัง live — กันเจ้าใดเจ้าหนึ่งค้างไม่ให้ล้มทั้งชุด
async function syncAll() {
  const live = _liveOrders.all();
  const results = [];
  for (const o of live) {
    try { results.push({ id: o.id, ...(await syncOrder(o)) }); }
    catch (e) { results.push({ id: o.id, error: e.message }); }
  }
  return results;
}

let _pollTimer = null;
function startPolling(everyMs = 60000) {
  if (_pollTimer || !hasProviders()) return;
  _pollTimer = setInterval(() => { syncAll().catch(() => {}); }, everyMs);
  console.log(`🔄 เริ่ม sync สถานะออเดอร์กับซัพพลายเออร์ทุก ${Math.round(everyMs / 1000)} วินาที`);
}

/* ───────────────────────── ข้อมูลสำหรับหน้าแอดมิน (ไม่มี apiKey) ───────────────────────── */
function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key, name: p.name, url: p.url, currency: p.currency, rateToCredit: p.rateToCredit,
  }));
}
async function balances() {
  const out = [];
  for (const p of Object.values(PROVIDERS)) {
    try { const b = await api.balance(p); out.push({ key: p.key, name: p.name, balance: b.balance, currency: b.currency || p.currency }); }
    catch (e) { out.push({ key: p.key, name: p.name, error: e.message }); }
  }
  return out;
}

module.exports = {
  hasProviders, reloadProviders, listProviders, balances,
  getServices, serviceMap, resolveRoute,
  dispatch, attachToOrder, syncOrder, syncAll, startPolling, mapStatus,
};
