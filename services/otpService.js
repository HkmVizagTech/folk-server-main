const axios = require('axios');
const crypto = require('crypto');
const { admin, db } = require('../config/firebase');

// Custom OTP flow via Flaxxa WAPI. This replaces Firebase Phone Auth (which
// requires the paid Blaze plan) with our own OTP generation, storage and
// verification, so the project stays on the free Spark tier.
// Codes are kept in a server-only `otp_codes` Firestore collection - the
// Admin SDK bypasses firestore.rules (all client access is denied), persists
// across restarts, and gives us 5-minute TTLs + resend/attempt rate limiting.

const OTP_TTL_MS = 5 * 60 * 1000;           // codes expire after 5 minutes
const MAX_RESENDS_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESENDS = 3;                      // per phone per 10 minutes
const MIN_RESEND_INTERVAL_MS = 60 * 1000;   // 1 minute between resends
const MAX_VERIFY_ATTEMPTS = 5;

const FLAXXA_API_URL = process.env.FLAXXA_API_URL || 'https://api.flaxxa.com/v1/wapi/messages';
const FLAXXA_OTP_TEMPLATE = process.env.FLAXXA_OTP_TEMPLATE || 'otp';

// Collapse any reasonable Indian phone representation to E.164 digits:
// 9876543210 → 919876543210, +91-98765-43210 → 919876543210, 091… → 91…
const normalizePhone = (phone) => {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (p.length === 10) p = `91${p}`;
  return p;
};

const isValidIndianPhone = (phone) => {
  const p = normalizePhone(phone);
  return /^91[6-9]\d{9}$/.test(p);
};

const generateOTP = () => {
  // randomInt is the CSPRNG-backed counter (unlike Math.random), so the codes
  // are genuinely unpredictable - an attacker cannot predict the next one.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
};

const isConfigured = () => Boolean(process.env.FLAXXA_API_KEY);

// Send the code via Flaxxa WAPI's `otp` template ({{1}} = the 6-digit code).
// Business-initiated WhatsApp messages must use an approved Meta template.
const sendOTPviaWhatsApp = async (phone, code) => {
  if (!isConfigured()) {
    console.warn(`[FLAXXA] FLAXXA_API_KEY not configured; skipping '${FLAXXA_OTP_TEMPLATE}' send to +${phone}.`);
    return false;
  }

  const body = {
    to: `+${phone}`,
    template: FLAXXA_OTP_TEMPLATE,
    vars: [code],
  };

  try {
    const res = await axios.post(FLAXXA_API_URL, body, {
      headers: {
        Authorization: `Bearer ${process.env.FLAXXA_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `otp-${phone}-${Date.now()}`,
      },
      timeout: 15000,
    });
    console.log(
      `[FLAXXA] OTP template '${FLAXXA_OTP_TEMPLATE}' sent to +${phone}:`,
      JSON.stringify(res.data && res.data.result ? res.data.result : res.data).slice(0, 300)
    );
    return true;
  } catch (error) {
    console.error('[FLAXXA] OTP send failed:', error.response?.data || error.message);
    return false;
  }
};

// Rate limiting: at most MAX_RESENDS sends per phone in the rolling window,
// and never more often than MIN_RESEND_INTERVAL_MS.
const canResend = async (phone) => {
  const snap = await db.collection('otp_codes').doc(phone).get();
  if (!snap.exists) return { ok: true };
  const now = Date.now();
  const history = (snap.data().sends || []).filter((t) => now - t < MAX_RESENDS_WINDOW_MS);
  if (history.length >= MAX_RESENDS) {
    return { ok: false, reason: 'Too many requests for this number. Please wait a few minutes and try again.' };
  }
  const last = history.length ? Math.max(...history) : 0;
  if (now - last < MIN_RESEND_INTERVAL_MS) {
    return { ok: false, reason: 'Please wait a minute before requesting another code.' };
  }
  return { ok: true };
};

// Persist a fresh code, pruning old send timestamps so the array stays small.
const storeOTP = async (phone, code, sends) => {
  const now = Date.now();
  const history = (sends || []).filter((t) => now - t < MAX_RESENDS_WINDOW_MS);
  history.push(now);
  await db.collection('otp_codes').doc(phone).set({
    code,
    phone,
    createdAt: admin.firestore.Timestamp.fromMillis(now),
    expiresAt: admin.firestore.Timestamp.fromMillis(now + OTP_TTL_MS),
    attempts: 0,
    sends: history,
  }, { merge: true });
};

// Consume (and by default delete) the stored code after verification.
const clearOTP = async (phone) => {
  await db.collection('otp_codes').doc(phone).delete().catch(() => {});
};

// Verify a submitted code: single-use, TTL-bounded, attempt-limited.
const verifyOTP = async (phone, code) => {
  const snap = await db.collection('otp_codes').doc(phone).get();
  if (!snap.exists) {
    return { ok: false, reason: 'No code was requested for this number. Please request a new OTP.' };
  }
  const data = snap.data();
  const now = new Date();

  if (data.expiresAt && data.expiresAt.toMillis() < now.getTime()) {
    await clearOTP(phone);
    return { ok: false, reason: 'That OTP has expired. Please request a new one.' };
  }

  if ((data.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await clearOTP(phone);
    return { ok: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
  }

  if (String(data.code) !== String(code || '').trim()) {
    const attempts = (data.attempts || 0) + 1;
    await db.collection('otp_codes').doc(phone).update({ attempts }).catch(() => {});
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await clearOTP(phone);
      return { ok: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
    }
    return { ok: false, reason: 'Invalid OTP. Please check and try again.' };
  }

  // Match + single-use: burn the code so it can never be replayed.
  await clearOTP(phone);
  return { ok: true };
};

module.exports = {
  normalizePhone,
  isValidIndianPhone,
  generateOTP,
  sendOTPviaWhatsApp,
  canResend,
  storeOTP,
  verifyOTP,
  clearOTP,
  isConfigured,
  OTP_TTL_MS,
};