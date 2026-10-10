'use strict';

const { db, admin } = require('../config/firebase');
const { sendTemplateMessage } = require('./notification.service');
const { normalizePhone, isValidIndianPhone } = require('../utils/phone');

const MAX_RECIPIENTS = 300;
const CONCURRENCY = 5;
const STAGES = ['new', 'regular', 'practising', 'committed', 'resident'];
const PHONE_INDEX_VERSION = 1;

// Mirrors the client's stageOf(): `stage`, else the older numeric `level`.
const stageOf = (u) => {
  if (STAGES.includes(u.stage)) return u.stage;
  const n = parseInt(u.level, 10);
  return Number.isInteger(n) && n >= 1 && n <= STAGES.length ? STAGES[n - 1] : 'new';
};

/**
 * Resolve the unique, valid phone numbers of an audience. Recipients are
 * never taken from the client; staff and members without a valid number are skipped.
 */
const resolveRecipients = async (user, type, stage) => {
  const snap = type === 'mine'
    ? await db.collection('users').where('guideId', '==', user.uid).get()
    : await db.collection('users').get();

  const seen = new Set();
  const recipients = [];
  for (const d of snap.docs) {
    const u = d.data();
    if (u.role === 'admin' || u.role === 'folks_head') continue;
    if (type === 'stage' && stageOf(u) !== stage) continue;
    const phone = normalizePhone(u.phone);
    if (!isValidIndianPhone(phone) || seen.has(phone)) continue;
    seen.add(phone);
    recipients.push(phone);
  }
  return recipients;
};

// Send in chunks of CONCURRENCY to stay polite to the WhatsApp API.
const sendAll = async (recipients, templateId, params) => {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const chunk = recipients.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((p) => sendTemplateMessage(p, templateId, params).catch(() => false)));
    results.forEach((ok) => (ok ? sent++ : failed++));
  }
  return { sent, failed };
};

const recordBroadcast = (user, { type, stage }, templateId, params, total, sent, failed) =>
  db.collection('broadcasts').add({
    byUid: user.uid,
    byName: user.name || '',
    audience: type === 'stage' ? { type, stage } : { type },
    templateId,
    params,
    total,
    sent,
    failed,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

/** Write phoneNormalized on every profile that lacks it (or has a stale one). */
const runPhoneBackfill = async () => {
  const snap = await db.collection('users').get();
  let updated = 0;
  let batch = db.batch();
  let inBatch = 0;
  for (const d of snap.docs) {
    const p = normalizePhone(d.data().phone);
    if (!p || d.data().phoneNormalized === p) continue;
    batch.update(d.ref, { phoneNormalized: p });
    updated++;
    if (++inBatch === 450) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  return { scanned: snap.size, updated };
};

/**
 * Runs the backfill once per deployment history (tracked in system/phoneIndex),
 * so OTP login's indexed lookups work for existing profiles without anyone
 * pressing a button. Safe to call on every boot.
 */
const ensurePhoneIndex = async () => {
  const ref = db.collection('system').doc('phoneIndex');
  const snap = await ref.get();
  if (snap.exists && snap.data().version >= PHONE_INDEX_VERSION) return { skipped: true };
  const result = await runPhoneBackfill();
  await ref.set({ version: PHONE_INDEX_VERSION, ...result, builtAt: admin.firestore.FieldValue.serverTimestamp() });
  return result;
};

module.exports = {
  MAX_RECIPIENTS, STAGES, resolveRecipients, sendAll, recordBroadcast, runPhoneBackfill, ensurePhoneIndex,
};
