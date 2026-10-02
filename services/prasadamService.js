/**
 * Weekend prasadam coupons for people who came to a program.
 *
 * When a member is marked present at an event the team has ticked
 * "gives a prasadam coupon", the community app (Vaikuntham) should hand that
 * person the coupon for the day. Attendance is written from three places —
 * the QR scanner, self check-in and the roll call, two of them in the browser
 * — so instead of hooking every write path this sweeps the attendance table
 * once a minute and tells the community app about rows it has not reported
 * yet. A sweep also survives a failed call, which fire-and-forget would not.
 *
 * State lives in `prasadam_grants`, one row per attendance record, keyed by
 * the same id (`<eventId>_<userId>`), which is also the idempotency key the
 * community app de-duplicates on. Un-ticking a name deliberately leaves the
 * coupon alone: the food is already eaten.
 *
 * Does nothing at all unless COMMUNITY_APP_GRANT_URL and
 * COMMUNITY_APP_GRANT_KEY are set.
 */
const axios = require('axios');
const { db, admin } = require('../config/firebase');

const GRANT_URL = (process.env.COMMUNITY_APP_GRANT_URL || '').trim();
const GRANT_KEY = (process.env.COMMUNITY_APP_GRANT_KEY || '').trim();

const BATCH_SIZE = 100;              // the community app allows 500; it asked for <= 100
const LOOK_BACK_MS = 48 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

// Results the community app will never change its mind about: stored and
// never retried. Anything else is worth another go.
const FINAL_RESULTS = new Set(['given', 'already', 'not_member', 'no_phone', 'invalid', 'no_session', 'not_open', 'ended']);
const SUCCESS_RESULTS = new Set(['given', 'already']);

// Backoff per attempt before a `failed` row is tried again.
const RETRY_DELAYS_MS = [60e3, 2 * 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3];
const retryDelay = (attempts) => RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];

const isConfigured = () => !!GRANT_URL && !!GRANT_KEY;

/** 'YYYY-MM-DD' in India for an event's start. */
const istDate = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

const asMillis = (v) => {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Events the team has marked as giving a coupon, that ran recently. */
const couponEvents = async (now) => {
  const snap = await db.collection('events').where('givesPrasadamCoupon', '==', true).get();
  const out = [];
  for (const doc of snap.docs) {
    const e = doc.data() || {};
    const startedAt = asMillis(e.dateISO || e.date);
    // Only events around now: an old one has nothing left to hand out, and a
    // future one has nobody at it yet.
    if (startedAt === null || now - startedAt > LOOK_BACK_MS || startedAt - now > 12 * 60 * 60 * 1000) continue;
    out.push({ id: doc.id, title: e.title || 'Program', date: istDate(e.dateISO || e.date) });
  }
  return out;
};

/** Attendance rows for those events that still need reporting. */
const pendingItems = async (events, now) => {
  const items = [];
  for (const event of events) {
    const snap = await db.collection('attendance').where('eventId', '==', event.id).get();
    for (const doc of snap.docs) {
      const a = doc.data() || {};
      const uid = a.userId || a.uid;
      if (!uid) continue;
      const markedAt = asMillis(a.createdAt || a.timestamp);
      if (markedAt !== null && now - markedAt > LOOK_BACK_MS) continue;

      const grantSnap = await db.collection('prasadam_grants').doc(doc.id).get();
      const g = grantSnap.exists ? grantSnap.data() : null;
      if (g && g.status === 'done') continue;
      if (g && g.status === 'final') continue;
      if (g && g.status === 'failed') {
        const last = asMillis(g.lastTriedAt) || 0;
        if (now - last < retryDelay(g.attempts || 0)) continue;
      }

      const userSnap = await db.collection('users').doc(uid).get();
      const u = userSnap.exists ? userSnap.data() : {};
      items.push({
        ref: doc.id,
        eventId: event.id,
        userId: uid,
        phone: u.phoneNormalized || '',
        name: u.name || u.fullName || a.name || '',
        date: event.date,
        program: event.title,
        attempts: (g && g.attempts) || 0,
      });
      if (items.length >= BATCH_SIZE) return items;
    }
  }
  return items;
};

const writeResult = async (item, { status, result, message, attempts }) => {
  await db.collection('prasadam_grants').doc(item.ref).set({
    ref: item.ref,
    eventId: item.eventId,
    userId: item.userId,
    phone: item.phone,
    name: item.name,
    date: item.date,
    program: item.program,
    status,
    result: result || null,
    message: message || null,
    attempts,
    lastTriedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
};

/**
 * One pass. Returns a short summary; never throws, because it runs on a timer.
 */
const sweepOnce = async () => {
  if (!isConfigured()) return { skipped: 'not-configured' };
  const now = Date.now();

  const events = await couponEvents(now);
  if (!events.length) return { events: 0, sent: 0 };

  const items = await pendingItems(events, now);
  if (!items.length) return { events: events.length, sent: 0 };

  let response;
  try {
    response = await axios.post(
      GRANT_URL,
      { items: items.map(({ ref, phone, name, date, program }) => ({ ref, phone, name, date, program })) },
      {
        headers: { 'X-API-Key': GRANT_KEY, 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );
  } catch (error) {
    // Could not reach the community app at all: leave every row to be retried.
    for (const item of items) {
      await writeResult(item, { status: 'failed', result: null, message: error.message, attempts: item.attempts + 1 });
    }
    console.error('[prasadam] grant call failed:', error.message);
    return { events: events.length, sent: items.length, error: error.message };
  }

  // A key that is wrong or not yet set on the other side is a configuration
  // problem, not a per-person one: say so once and retry later, without
  // burning attempts or marking anybody.
  if (response.status === 401 || response.status === 503) {
    console.error(`[prasadam] community app refused the key (HTTP ${response.status}). Nothing marked; will retry.`);
    return { events: events.length, sent: items.length, error: `auth-${response.status}` };
  }
  if (response.status !== 200 || !response.data || !Array.isArray(response.data.results)) {
    for (const item of items) {
      await writeResult(item, { status: 'failed', result: null, message: `HTTP ${response.status}`, attempts: item.attempts + 1 });
    }
    console.error(`[prasadam] unexpected reply (HTTP ${response.status}).`);
    return { events: events.length, sent: items.length, error: `http-${response.status}` };
  }

  const byRef = new Map(response.data.results.map((r) => [r.ref, r]));
  const tally = { given: 0, already: 0, final: 0, failed: 0 };
  for (const item of items) {
    const r = byRef.get(item.ref);
    if (!r) {
      await writeResult(item, { status: 'failed', result: null, message: 'no result returned', attempts: item.attempts + 1 });
      tally.failed += 1;
      continue;
    }
    const result = String(r.result || '');
    if (SUCCESS_RESULTS.has(result)) {
      await writeResult(item, { status: 'done', result, message: r.message, attempts: item.attempts });
      tally[result === 'given' ? 'given' : 'already'] += 1;
    } else if (FINAL_RESULTS.has(result)) {
      // Nothing more to do, but the team should be able to see why — for
      // example "not on the app yet".
      await writeResult(item, { status: 'final', result, message: r.message, attempts: item.attempts });
      tally.final += 1;
    } else {
      await writeResult(item, { status: 'failed', result: result || null, message: r.message, attempts: item.attempts + 1 });
      tally.failed += 1;
    }
  }

  console.log(`[prasadam] ${items.length} sent: ${tally.given} given, ${tally.already} already, ${tally.final} final, ${tally.failed} to retry`);
  return { events: events.length, sent: items.length, ...tally };
};

let running = false;
let timer = null;

/** Runs the sweep, never two at once. */
const runSweep = async () => {
  if (running) return { skipped: 'already-running' };
  running = true;
  try {
    return await sweepOnce();
  } catch (error) {
    console.error('[prasadam] sweep failed:', error);
    return { error: error.message };
  } finally {
    running = false;
  }
};

const startSweeper = () => {
  if (!isConfigured()) {
    console.log('[prasadam] COMMUNITY_APP_GRANT_URL/KEY not set; prasadam coupons are off.');
    return null;
  }
  if (timer) return timer;
  console.log(`[prasadam] coupon sweep every ${SWEEP_MS / 1000}s → ${GRANT_URL}`);
  timer = setInterval(() => { runSweep(); }, SWEEP_MS);
  timer.unref();
  return timer;
};

module.exports = { startSweeper, runSweep, sweepOnce, isConfigured, istDate, FINAL_RESULTS, SUCCESS_RESULTS };
