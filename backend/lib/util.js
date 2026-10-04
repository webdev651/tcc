const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const store = require('../db');

const IS_PROD = process.env.NODE_ENV === 'production';

// The signing secret must stay the same across restarts, otherwise every restart logs everybody out.
// Order: JWT_SECRET env var (recommended for hosting) -> a random secret saved next to the database -> new random secret.
const SECRET_FILE = path.join(path.dirname(store.FILE), '.jwt-secret');
let SECRET_SOURCE = 'env';
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try { const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (saved.length >= 32) { SECRET_SOURCE = 'file'; return saved; } } catch {}
  const fresh = crypto.randomBytes(48).toString('hex');
  try { fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true }); fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600 }); SECRET_SOURCE = 'file'; } catch { SECRET_SOURCE = 'memory'; }
  return fresh;
}
const JWT_SECRET = loadSecret();
const isLoopback = (ip) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(ip || ''));

const norm = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isStudentId = (v) => /^\d{4}-\d{4,6}$/.test(v);
const fail = (res, status, error) => res.status(status).json({ error });
const settings = () => store.get().settings;
const minPw = () => settings().security.minPasswordLength || 8;
const validPassword = (pw) => typeof pw === 'string' && pw.length >= minPw() && pw.length <= 100 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
const pwRule = () => `Password needs at least ${minPw()} characters, with a letter and a number.`;
const tempPassword = () => 'Tcc' + crypto.randomBytes(4).toString('hex') + '9';

// Remove HTML tags and control characters from free text. The UI also escapes on output.
const clean = (v, max = 500) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

/**
 * validate(body, spec) -> { data } | { error }
 * spec entries: { label, required, max, enum, date, time, email, pattern, num, min, max }
 */
function validate(body, spec) {
  const out = {}; body = body || {};
  for (const [k, r] of Object.entries(spec)) {
    const label = r.label || k;
    let v = body[k] ?? '';
    if (typeof v === 'string') v = clean(v, r.maxLen || 500);
    if (typeof v === 'boolean') { out[k] = v; continue; }
    if (v === '' && r.required) return { error: `${label} is required.` };
    if (v !== '') {
      if (r.enum && !r.enum.includes(v)) return { error: `${label} has an invalid value.` };
      if (r.date && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v)))) return { error: `${label} must be a valid date.` };
      if (r.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { error: `${label} must be a valid time.` };
      if (r.email && !isEmail(v)) return { error: `${label} must be a valid email address.` };
      if (r.pattern && !r.pattern.test(v)) return { error: r.msg || `${label} is not in the right format.` };
      if (r.num) { const n = Number(v); if (!Number.isFinite(n) || (r.min != null && n < r.min) || (r.max != null && n > r.max)) return { error: `${label} must be a number${r.min != null ? ` between ${r.min} and ${r.max}` : ''}.` }; v = n; }
    }
    out[k] = v;
  }
  return { data: out };
}

// ---------- sessions & auth ----------
// Accounts and sessions live in MySQL (see ../db.js). The JWT still carries the session id (jti).
async function issueToken(user, remember) {
  const hours = settings().security.sessionHours || 8;
  const ttlMs = remember ? 30 * 24 * 3600e3 : hours * 3600e3;
  const jti = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  await store.purgeExpiredSessions(now);
  await store.createSession({ jti, userId: user.id, exp: now + ttlMs, lastSeen: now, remember: !!remember });
  return jwt.sign({ sub: user.id, role: user.role, jti }, JWT_SECRET, { expiresIn: Math.floor(ttlMs / 1000) });
}

function requireAuth(roles) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
      if (!token) return fail(res, 401, 'Please log in first.');
      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); } catch { return fail(res, 401, 'Your session has expired. Please log in again.'); }
      const now = Date.now();
      const session = await store.getSession(payload.jti);
      if (!session || session.exp < now) return fail(res, 401, 'Your session has ended. Please log in again.');
      const idleMs = (settings().security.idleMinutes || 30) * 60e3;
      // "Remember me" sessions skip the idle timeout; they last until their expiry date or logout.
      if (!session.remember && now - session.lastSeen > idleMs) {
        await store.deleteSession(session.jti);
        return fail(res, 401, 'You were signed out after a period of inactivity.');
      }
      // Background polling (the notification bell) must not keep an idle session alive.
      const passive = req.method === 'GET' && req.originalUrl.startsWith('/api/auth/notifications');
      if (!passive && now - session.lastSeen > 30e3) {
        session.lastSeen = now;
        await store.touchSession(session.jti, now);
      }
      const user = await store.getUserById(payload.sub);
      if (!user) return fail(res, 401, 'Account no longer exists.');
      if (user.status === 'disabled') return fail(res, 403, 'This account has been disabled. Contact the clinic administrator.');
      if (roles && !roles.includes(user.role)) return fail(res, 403, 'You do not have access to this.');
      req.user = user; req.session = session;
      next();
    } catch (e) { next(e); }
  };
}

// Lets an async route handler throw (or reject) and have Express's error handler answer, instead of hanging.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Admins can do everything; staff are limited by the permission switches in Settings.
const can = (perm) => (req, res, next) => {
  if (req.user.role === 'admin' || (settings().permissions.staff || {})[perm]) return next();
  return fail(res, 403, 'Your account does not have permission to do this. Ask an administrator.');
};

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
function limiter({ max, windowMs, key = (req) => req.ip, message = 'Too many attempts. Please wait and try again.' }) {
  return (req, res, next) => {
    const k = key(req); const now = Date.now(); let b = buckets.get(k);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    if (++b.n > max) return fail(res, 429, message);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60e3).unref();

const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, studentId: u.studentId, photo: u.photo || '' });

// ---------- appointment helpers (shared by student and staff routes) ----------
const ACTIVE = ['pending', 'approved'];
const effStatus = (a) => (a.status === 'approved' && a.date >= store.isoDay(0) ? 'upcoming' : a.status);
function slotsFor(date) {
  const d = new Date(date + 'T00:00:00'); const dow = d.getDay();
  if (dow === 0) return []; // Sunday closed
  const morning = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30'];
  const afternoon = ['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];
  return dow === 6 ? morning : morning.concat(afternoon);
}
function slotStatus(date, exceptId) {
  const taken = store.get().appointments.filter((a) => a.date === date && ACTIVE.includes(a.status) && a.id !== exceptId).map((a) => a.time);
  const today = store.isoDay(0); const nowT = new Date(); const hhmm = `${String(nowT.getHours()).padStart(2, '0')}:${String(nowT.getMinutes()).padStart(2, '0')}`;
  return slotsFor(date).map((t) => ({ time: t, available: !taken.includes(t) && !(date === today && t <= hhmm) }));
}
function checkSlot(date, time, exceptId) {
  if (date < store.isoDay(0)) return 'Please choose a future date.';
  if (date > store.isoDay(settings().general.maxAdvanceDays || 60)) return 'That date is too far ahead. Please choose a nearer date.';
  const s = slotStatus(date, exceptId).find((x) => x.time === time);
  if (!s) return 'The clinic is not open at that time. Please pick another slot.';
  if (!s.available) return 'That time is no longer available. Please pick another.';
  return null;
}

module.exports = { ah, JWT_SECRET, SECRET_SOURCE: () => SECRET_SOURCE, isLoopback, IS_PROD, norm, isEmail, isStudentId, fail, settings, validPassword, pwRule, tempPassword, clean, validate, issueToken, requireAuth, can, limiter, publicUser, ACTIVE, effStatus, slotStatus, checkSlot };
