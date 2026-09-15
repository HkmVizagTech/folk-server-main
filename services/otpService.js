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

// Verified Flaxxa WAPI integration (ported from the HKMV project):
//   POST https://wapi.flaxxa.com/api/v1/sendtemplatemessage
//   body { token, phone, template_name, template_language, components }
// The auth token is a BODY field here, not an Authorization header.
const FLAXXA_API_URL =
  process.env.WAPI_BASE || 'https://wapi.flaxxa.com/api/v1/sendtemplatemessage';
const FLAXXA_OTP_TEMPLATE =
  process.env.WAPI_OTP_TEMPLATE_NAME || process.env.FLAXXA_OTP_TEMPLATE || 'otp';
const FLAXXA_TEMPLATE_LANG = process.env.WAPI_TEMPLATE_LANG || 'en';

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

// WAPI_TOKEN is the name the proven integration uses; FLAXXA_API_KEY is kept
// as a fallback so an already-configured Railway variable keeps working.
const flaxxaToken = () => process.env.WAPI_TOKEN || process.env.FLAXXA_API_KEY || '';
const isConfigured = () => Boolean(flaxxaToken());

// Send the code via Flaxxa WAPI's approved `otp` template.
// Business-initiated WhatsApp messages must use a Meta-approved template.
const sendOTPviaWhatsApp = async (phone, code) => {
  if (!isConfigured()) {
    console.warn(`[FLAXXA] No WAPI_TOKEN/FLAXXA_API_KEY configured; skipping '${FLAXXA_OTP_TEMPLATE}' send to +${phone}.`);
    return false;
  }

  // Authentication templates: Meta rewrites the copy-code button into a URL
  // button at approval time, so the code must be supplied TWICE — once as the
  // body variable and once as the button URL parameter. sub_type "COPY_CODE"
  // is rejected (#132018) and omitting the button is rejected (#131008).
  const components = [
    { type: 'body', parameters: [{ type: 'text', text: String(code) }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] },
  ];

  try {
    const res = await axios.post(
      FLAXXA_API_URL,
      {
        token: flaxxaToken(),      // token is a body field for Flaxxa WAPI
        phone,                     // E.164 without "+", e.g. 919876543210
        template_name: FLAXXA_OTP_TEMPLATE,
        template_language: FLAXXA_TEMPLATE_LANG,
        components,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    // Flaxxa answers HTTP 200 even when Meta rejected the message. The only
    // reliable success signal is a non-null message_wamid; without this check
    // the caller would report "OTP sent" for a message that never left.
    const wamid = res.data && (res.data.message_wamid || res.data.wamid);
    if (!wamid) {
      console.error(
        `[FLAXXA] OTP template '${FLAXXA_OTP_TEMPLATE}' rejected for +${phone}:`,
        JSON.stringify(res.data).slice(0, 300)
      );
      return false;
    }

    console.log(`[FLAXXA] OTP sent to +${phone} (wamid ${wamid}).`);
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