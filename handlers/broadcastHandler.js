const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const functions = require('firebase-functions');
const { sendTemplateMessage, isConfigured } = require('../services/notificationService');
const { normalizePhone, isValidIndianPhone } = require('../services/otpService');

const MAX_RECIPIENTS = 300;
const CONCURRENCY = 5;
const STAGES = ['new', 'regular', 'practising', 'committed', 'resident'];

// Mirrors the client's stageOf(): `stage`, else the older numeric `level`.
const stageOf = (u) => {
  if (STAGES.includes(u.stage)) return u.stage;
  const n = parseInt(u.level, 10);
  return Number.isInteger(n) && n >= 1 && n <= STAGES.length ? STAGES[n - 1] : 'new';
};

const bad = (msg) => new functions.https.HttpsError('invalid-argument', msg);

/**
 * POST /broadcast { audience: { type: 'mine' | 'all' | 'stage', stage? }, templateId, params[] }
 * Sends an approved WhatsApp template (Gupshup) to a group of members.
 * Recipients are resolved here from Firestore, never taken from the client,
 * and a FOLK guide can only reach the members assigned to them.
 */
exports.broadcast = async (data, context) => {
  const user = await validateAdminOrHead(context);
  data = data && typeof data === 'object' ? data : {};

  if (!isConfigured()) {
    throw new functions.https.HttpsError('failed-precondition',
      'WhatsApp sending is not set up on the server yet (GUPSHUP_API_KEY, GUPSHUP_SOURCE, GUPSHUP_APP_NAME).');
  }

  const templateId = typeof data.templateId === 'string' ? data.templateId.trim() : '';
  if (!/^[\w.-]{1,100}$/.test(templateId)) throw bad('Enter a valid template ID.');

  const params = Array.isArray(data.params) ? data.params : [];
  if (params.length > 10 || params.some((p) => typeof p !== 'string' || p.length > 200)) {
    throw bad('Up to 10 template values, each at most 200 characters.');
  }

  const type = data.audience && data.audience.type;
  const stage = data.audience && data.audience.stage;
  if (!['mine', 'all', 'stage'].includes(type)) throw bad('Choose who to send to.');
  if (type === 'stage' && !STAGES.includes(stage)) throw bad('Choose a valid stage.');
  if (type !== 'mine' && user.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'FOLK guides can only message their own members.');
  }

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

  if (recipients.length === 0) throw bad('Nobody in this group has a valid mobile number.');
  if (recipients.length > MAX_RECIPIENTS) {
    throw bad(`That's ${recipients.length} people; one broadcast can reach at most ${MAX_RECIPIENTS}. Narrow the group.`);
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const chunk = recipients.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((p) => sendTemplateMessage(p, templateId, params).catch(() => false)));
    results.forEach((ok) => (ok ? sent++ : failed++));
  }

  await db.collection('broadcasts').add({
    byUid: user.uid,
    byName: user.name || '',
    audience: type === 'stage' ? { type, stage } : { type },
    templateId,
    params,
    total: recipients.length,
    sent,
    failed,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { total: recipients.length, sent, failed };
};

const PHONE_INDEX_VERSION = 1;

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
 * having to press a button. Safe to call on every boot.
 */
exports.ensurePhoneIndex = async () => {
  const ref = db.collection('system').doc('phoneIndex');
  const snap = await ref.get();
  if (snap.exists && snap.data().version >= PHONE_INDEX_VERSION) return { skipped: true };
  const result = await runPhoneBackfill();
  await ref.set({ version: PHONE_INDEX_VERSION, ...result, builtAt: admin.firestore.FieldValue.serverTimestamp() });
  return result;
};

/**
 * POST /backfillPhoneIndex (admin only)
 * Writes users/{uid}.phoneNormalized for every profile, so phone login can
 * find accounts with an indexed query instead of scanning the collection.
 */
exports.backfillPhoneIndex = async (data, context) => {
  const user = await validateAdminOrHead(context);
  if (user.role !== 'admin') throw new functions.https.HttpsError('permission-denied', 'Admins only.');
  return runPhoneBackfill();
};
