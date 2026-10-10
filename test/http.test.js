'use strict';

/**
 * End-to-end over HTTP: the real Express app against a throwaway Postgres,
 * speaking the website's wire format (see folk-client/src/lib/pgstore.js):
 *   POST /dbGet /dbQuery /dbCommit /dbChanges  body { data }  ->  { result } | { error: { message, status, code } }
 * Firebase ID-token verification is replaced by a stub: "Bearer uid:<uid>".
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');
const { createPool } = require('../src/db/store/pool');

let dbh;
let server;
let base;
let appDb;
let pool;

const call = async (fn, data, uid) => {
  const res = await fetch(`${base}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer uid:${uid}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json() };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
const denied = (r) => {
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'permission-denied');
  assert.equal(r.body.error.status, 'PERMISSION_DENIED');
};
const SERVER_TS = { __op: 'serverTimestamp' };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

before(async () => {
  dbh = await createDatabase();
  // A database that still has the OLD generic tables, including the marker
  // that says the Firestore copy already happened.
  pool = createPool(dbh.url, { max: 2 });
  await pool.query(`CREATE TABLE "system" (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}', version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO "system" (id, data) VALUES ('migration', '{"source":"firestore","completedAt":"2026-01-01T00:00:00.000Z","counts":{"users":3}}')`);

  process.env.DATABASE_URL = dbh.url;
  delete process.env.DATA_BACKEND;
  const admin = require('firebase-admin');
  Object.defineProperty(admin, 'auth', {
    configurable: true,
    value: () => ({
      verifyIdToken: async (t) => {
        if (typeof t === 'string' && t.startsWith('uid:')) return { uid: t.slice(4) };
        throw new Error('invalid token');
      },
    }),
  });
  const { db } = require('../src/config/firebase');
  appDb = db;
  const database = require('../src/services/database.service');
  await database.init();
  assert.equal(database.getError(), null);
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  for (const [uid, role, extra] of [['adm', 'admin', {}], ['gd', 'folks_head', {}], ['dev1', 'devotee', { name: 'Devotee One', streak: 0, score: 0 }], ['dev2', 'devotee', { name: 'Devotee Two' }]]) {
    await db.collection('users').doc(uid).set({ uid, name: uid, role, ...extra });
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await appDb.close();
  await pool.end();
  await dbh.drop();
});

test('boot: schema migrated automatically, legacy marker preserved, no Firestore copy attempted', async () => {
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), ['001', '002']);
  const legacy = await pool.query("SELECT count(*)::int n FROM legacy_system");
  assert.equal(legacy.rows[0].n, 1);
  const marker = await pool.query("SELECT completed_at, counts FROM system WHERE id = 'migration'");
  assert.equal(marker.rows[0].completed_at.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(marker.rows[0].counts, { users: 3 });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
});

test('dbGet: missing document, and who may read what', async () => {
  assert.deepEqual(ok(await call('dbGet', { path: 'sadhana_logs/dev1_2026-10-10' }, 'dev1')), { id: 'dev1_2026-10-10', exists: false, data: null, v: null });
  const own = ok(await call('dbGet', { path: 'users/dev1' }, 'dev1'));
  assert.equal(own.exists, true);
  assert.equal(own.v, 'v1');
  assert.equal(own.data.role, 'devotee');
  denied(await call('dbGet', { path: 'users/dev1' }, 'dev2'));
  denied(await call('dbGet', { path: 'users/dev1' }));
  denied(await call('dbGet', { path: 'otp_codes/919876543210' }, 'adm'));
  denied(await call('dbGet', { path: 'event_secrets/x' }, 'adm'));
  denied(await call('dbGet', { path: 'some_unknown_collection/x' }, 'adm'));
  const bad = await call('dbGet', { path: 'nonsense' }, 'adm');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid-argument');
  assert.equal((await call('dbGet', { path: 'users/dev1' }, 'bad-token')).status, 403);
});

test('a devotee writes their own sadhana log (the two-step client flow) and the user summary', async () => {
  const path = `sadhana_logs/dev1_${todayIST()}`;
  const date = todayIST();
  ok(await call('dbCommit', { writes: [{ type: 'set', path, data: { userId: 'dev1', date, target: 16, roundsCompleted: 0, progressPercentage: 0, streak: 0, score: 0, status: 'locked', createdAt: SERVER_TS } }] }, 'dev1'));
  let got = ok(await call('dbGet', { path }, 'dev1'));
  assert.equal(got.v, 'v1');
  assert.match(got.data.createdAt, ISO);
  assert.equal(got.data.date, date);
  // step 2 with a precondition on the version just read, plus the users row in the same commit
  ok(await call('dbCommit', {
    preconditions: [{ path, v: 'v1' }, { path: 'users/dev1', v: 'v1' }],
    writes: [
      { type: 'update', path, data: { roundsCompleted: 16, progressPercentage: 100, completed: true, streak: 1, score: 42, updatedAt: SERVER_TS } },
      { type: 'update', path: 'users/dev1', data: { streak: 1, longestStreak: 1, score: 42, lastSadhanaDate: date, lastCompletedSadhanaDate: date, updatedAt: SERVER_TS } },
    ],
  }, 'dev1'));
  got = ok(await call('dbGet', { path }, 'dev1'));
  assert.equal(got.v, 'v2');
  assert.equal(got.data.roundsCompleted, 16);
  assert.equal(got.data.completed, true);
  const q = ok(await call('dbQuery', { collection: 'sadhana_logs', filters: [{ field: 'userId', op: '==', value: 'dev1' }], orders: [{ field: 'date', dir: 'desc' }], limit: 7 }, 'dev1'));
  assert.equal(q.docs.length, 1);
  assert.deepEqual(q.docs[0], { id: `dev1_${date}`, data: got.data, v: 'v2' });
  // the same row, as SQL sees it
  const { rows } = await pool.query('SELECT user_id, log_date, rounds_completed, completed, doc_created_at, version FROM sadhana_logs WHERE id = $1', [`dev1_${date}`]);
  assert.equal(rows[0].user_id, 'dev1');
  assert.equal(rows[0].log_date, date);
  assert.equal(rows[0].rounds_completed, 16);
  assert.equal(Number(rows[0].version), 2);
  assert.ok(rows[0].doc_created_at instanceof Date);
  const u = ok(await call('dbGet', { path: 'users/dev1' }, 'dev1'));
  assert.equal(u.data.score, 42);
  assert.equal(u.data.lastSadhanaDate, date);
});

test('policy denials: forging another user, stale precondition, staff-managed fields', async () => {
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'sadhana_logs/dev2_2026-10-10', data: { userId: 'dev2', date: '2026-10-10', score: 9999 } }] }, 'dev1'));
  assert.equal((await appDb.collection('sadhana_logs').doc('dev2_2026-10-10').get()).exists, false);
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'users/dev1', data: { role: 'admin' } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'users/dev1', data: { guideId: 'gd' } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'payments/order_FAKE', data: { userId: 'dev1', status: 'completed', verified: true } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'sadhana_logs/x_1', data: { userId: 'dev1' } }] })); // signed out
  // nothing from the denied commits leaked into the tables
  assert.equal((await appDb.collection('payments').doc('order_FAKE').get()).exists, false);
  const stale = await call('dbCommit', {
    preconditions: [{ path: 'users/dev1', v: 'v1' }],
    writes: [{ type: 'update', path: 'users/dev1', data: { city: 'Vizag' } }],
  }, 'dev1');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'aborted');
  assert.equal(stale.body.error.status, 'ABORTED');
  assert.equal((await appDb.collection('users').doc('dev1').get()).data().city, undefined);
});

test('event RSVP counters: allowed by exactly one, with the precondition retry flow', async () => {
  ok(await call('dbCommit', { writes: [{ type: 'set', path: 'events/evtA', data: { title: 'Sunday', category: 'Weekly Program', date: 'Sun, Oct 11, 6:30 PM', dateISO: '2026-10-11T13:00:00.000Z', audience: 'all', ownerId: 'adm', attendingCount: 0, declinedCount: 0, createdAt: SERVER_TS } }] }, 'adm'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'events/evtB', data: { title: 'Nope', audience: 'all' } }] }, 'dev1'));
  // the client's runTransaction: read, then commit with the versions it read
  const ev = ok(await call('dbGet', { path: 'events/evtA' }, 'dev1'));
  const rsvp = (count) => ({
    preconditions: [{ path: 'events/evtA', v: ev.v }, { path: 'registrations/evtA_dev1', v: null }],
    writes: [
      { type: 'update', path: 'events/evtA', data: { attendingCount: count } },
      { type: 'set', path: 'registrations/evtA_dev1', data: { eventId: 'evtA', eventTitle: 'Sunday', userId: 'dev1', userName: 'Devotee One', token: 'AB12CD34', status: 'Attending', updatedAt: SERVER_TS }, merge: true },
    ],
  });
  denied(await call('dbCommit', rsvp(5), 'dev1')); // +5 is not an RSVP
  ok(await call('dbCommit', rsvp(1), 'dev1'));
  // a second browser holding the old version must be told to retry
  const clash = await call('dbCommit', { preconditions: [{ path: 'events/evtA', v: ev.v }], writes: [{ type: 'update', path: 'events/evtA', data: { attendingCount: 1 } }] }, 'dev2');
  assert.equal(clash.status, 409);
  // ...and succeeds with a fresh read, here using the increment sentinel
  const fresh = ok(await call('dbGet', { path: 'events/evtA' }, 'dev2'));
  assert.equal(fresh.data.attendingCount, 1);
  ok(await call('dbCommit', { preconditions: [{ path: 'events/evtA', v: fresh.v }], writes: [{ type: 'update', path: 'events/evtA', data: { attendingCount: { __op: 'increment', n: 1 } } }] }, 'dev2'));
  assert.equal(ok(await call('dbGet', { path: 'events/evtA' }, 'adm')).data.attendingCount, 2);
  // moving to "not attending": -1 / +1
  ok(await call('dbCommit', { writes: [{ type: 'update', path: 'events/evtA', data: { attendingCount: 1, declinedCount: 1 } }] }, 'dev2'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'events/evtA', data: { attendingCount: -1 } }] }, 'dev2'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'events/evtA', data: { title: 'Hacked' } }] }, 'dev2'));
  const reg = ok(await call('dbGet', { path: 'registrations/evtA_dev1' }, 'dev1'));
  assert.equal(reg.data.status, 'Attending');
  assert.equal(reg.data.token, 'AB12CD34');
  denied(await call('dbGet', { path: 'registrations/evtA_dev1' }, 'dev2'));
  // list is filtered per document: dev2 sees none of dev1's registrations, staff sees them
  const filt = [{ field: 'eventId', op: '==', value: 'evtA' }];
  assert.equal(ok(await call('dbQuery', { collection: 'registrations', filters: filt }, 'dev2')).docs.length, 0);
  assert.equal(ok(await call('dbQuery', { collection: 'registrations', filters: filt }, 'gd')).docs.length, 1);
  // public site: signed-out list of events works and keeps timestamps as ISO strings
  const pub = ok(await call('dbQuery', { collection: 'events', filters: [], orders: [{ field: 'dateISO', dir: 'asc' }] }));
  assert.equal(pub.docs.length, 1);
  assert.match(pub.docs[0].data.dateISO, ISO);
});

test('trip booking: create pending, owner fills travellers, limits enforced, payment fields staff/server only', async () => {
  ok(await call('dbCommit', { writes: [{ type: 'set', path: 'trips/tripA', data: { slug: 'srikurmam-yatra', title: 'Srikurmam', price: 49, originalPrice: 1300, advanceAmount: 0, capacity: 25, status: 'upcoming', registrationOpen: true, startDate: '2026-10-10', endDate: '2026-10-10', gallery: [], highlights: ['Darshan'], itinerary: [{ day: 1, title: 'Go', details: 'Bus' }], createdBy: 'adm', createdAt: SERVER_TS } }] }, 'adm'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'trips/tripA', data: { price: 1 } }] }, 'dev1'));
  const pubTrips = ok(await call('dbQuery', { collection: 'trips', filters: [{ field: 'slug', op: '==', value: 'srikurmam-yatra' }] }));
  assert.equal(pubTrips.docs[0].data.price, 49);
  assert.deepEqual(pubTrips.docs[0].data.itinerary, [{ day: 1, title: 'Go', details: 'Bus' }]);
  // duplicate slug: unique violation reaches the browser as already-exists
  const dup = await call('dbCommit', { writes: [{ type: 'set', path: 'trips/tripDup', data: { slug: 'srikurmam-yatra', title: 'Dup' } }] }, 'adm');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'already-exists');

  const reg = { tripId: 'tripA', tripSlug: 'srikurmam-yatra', tripTitle: 'Srikurmam', userId: 'dev1', userName: 'Devotee One', userPhone: '9876500002', seats: 2, amountDue: 98, paymentMode: 'online', paymentOrderId: null, status: 'pending', cashCollected: false, createdAt: SERVER_TS, updatedAt: SERVER_TS };
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'trip_registrations/r1', data: { ...reg, status: 'confirmed' } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'trip_registrations/r1', data: { ...reg, seats: 21 } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'trip_registrations/r1', data: { ...reg, cashAmount: 5 } }] }, 'dev1'));
  ok(await call('dbCommit', { writes: [{ type: 'set', path: 'trip_registrations/r1', data: reg }] }, 'dev1'));
  const trav = (n) => ({ name: `T${n}`, age: 20 + n, gender: 'Male', idType: 'aadhaar', idNumber: `99${n}`, college: 'GITAM', course: 'BTech', year: '2nd year' });
  ok(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { travellers: [trav(1), trav(2)], emergencyContact: 'Mom 9999999999', pickup: 'Gate 1', travellerNotes: 'veg', updatedAt: SERVER_TS } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { travellers: [trav(1), trav(2), trav(3)], updatedAt: SERVER_TS } }] }, 'dev1')); // more than the seats paid for
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { seats: 5, updatedAt: SERVER_TS } }] }, 'dev1'));
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { status: 'confirmed', updatedAt: SERVER_TS } }] }, 'dev1'));
  const got = ok(await call('dbGet', { path: 'trip_registrations/r1' }, 'dev1'));
  assert.equal(got.data.travellers.length, 2);
  assert.equal(got.data.travellers[1].name, 'T2');
  assert.equal(got.data.seats, 2);
  assert.equal(got.data.amountDue, 98);
  assert.equal(got.data.paymentOrderId, null); // explicit null survives
  assert.equal('cashAmount' in got.data, false); // absent stays absent
  // other devotees cannot see it; staff can, and record cash
  denied(await call('dbGet', { path: 'trip_registrations/r1' }, 'dev2'));
  assert.equal(ok(await call('dbQuery', { collection: 'trip_registrations', filters: [{ field: 'tripId', op: '==', value: 'tripA' }] }, 'dev2')).docs.length, 0);
  assert.equal(ok(await call('dbQuery', { collection: 'trip_registrations', filters: [{ field: 'tripId', op: '==', value: 'tripA' }, { field: 'status', op: 'in', value: ['pending', 'confirmed'] }] }, 'adm')).docs.length, 1);
  ok(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { cashCollected: true, cashAmount: 98, cashCollectedAt: SERVER_TS, cashCollectedBy: 'adm', status: 'confirmed', updatedAt: SERVER_TS } }] }, 'adm'));
  const { rows } = await pool.query('SELECT seats, amount_due, status, cash_collected, cash_amount, jsonb_array_length(travellers) AS n, payment_order_id, extra FROM trip_registrations WHERE id = $1', ['r1']);
  assert.deepEqual(rows[0], { seats: 2, amount_due: 98, status: 'confirmed', cash_collected: true, cash_amount: 98, n: 2, payment_order_id: null, extra: { paymentOrderId: null } });
  // owner can still cancel only while pending: it is confirmed now
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'trip_registrations/r1', data: { status: 'cancelled', updatedAt: SERVER_TS } }] }, 'dev1'));
});

test('seva join / leave moves countRegistered by one together with the registration', async () => {
  ok(await call('dbCommit', { writes: [{ type: 'set', path: 'sevas/sevaA', data: { title: 'Cleaning', sevaType: 'cleaning', date: '2026-10-12', time: '18:30', maxVolunteers: 2, countRegistered: 0, isRecurring: false, createdBy: 'adm', createdAt: SERVER_TS } }] }, 'adm'));
  const join = (uid) => ({ writes: [
    { type: 'update', path: 'sevas/sevaA', data: { countRegistered: { __op: 'increment', n: 1 } } },
    { type: 'set', path: `seva_registrations/${uid}_sevaA`, data: { userId: uid, sevaId: 'sevaA', sevaTitle: 'Cleaning', status: 'registered', createdAt: SERVER_TS, updatedAt: SERVER_TS } },
  ] });
  ok(await call('dbCommit', join('dev1'), 'dev1'));
  denied(await call('dbCommit', join('dev1'), 'dev1')); // already holding a seat
  denied(await call('dbCommit', { writes: [{ type: 'update', path: 'sevas/sevaA', data: { countRegistered: { __op: 'increment', n: 2 } } }] }, 'dev2'));
  ok(await call('dbCommit', join('dev2'), 'dev2'));
  denied(await call('dbCommit', join('gd2'), 'dev1')); // someone else's seat
  assert.equal(ok(await call('dbGet', { path: 'sevas/sevaA' }, 'dev1')).data.countRegistered, 2);
  // leave
  ok(await call('dbCommit', { writes: [
    { type: 'update', path: 'sevas/sevaA', data: { countRegistered: { __op: 'increment', n: -1 } } },
    { type: 'update', path: 'seva_registrations/dev1_sevaA', data: { status: 'cancelled', updatedAt: SERVER_TS } },
  ] }, 'dev1'));
  const roster = ok(await call('dbQuery', { collection: 'seva_registrations', filters: [{ field: 'sevaId', op: '==', value: 'sevaA' }, { field: 'status', op: '==', value: 'registered' }] }, 'adm'));
  assert.deepEqual(roster.docs.map((d) => d.id), ['dev2_sevaA']);
  assert.equal(ok(await call('dbGet', { path: 'sevas/sevaA' }, 'dev1')).data.countRegistered, 1);
});

test('dbQuery: filters, orders, limits, __name__, bad input', async () => {
  const mk = (n) => ({ type: 'set', path: `notifications/nq${n}`, data: { type: 'new_event', title: `t${n}`, message: 'm', link: '/events', createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(), createdBy: 'adm' } });
  ok(await call('dbCommit', { writes: [1, 2, 3, 4, 5].map(mk) }, 'adm'));
  const top = ok(await call('dbQuery', { collection: 'notifications', orders: [{ field: 'createdAt', dir: 'desc' }], limit: 3 }, 'dev1'));
  assert.deepEqual(top.docs.map((d) => d.id), ['nq5', 'nq4', 'nq3']);
  assert.match(top.docs[0].data.createdAt, ISO);
  const range = ok(await call('dbQuery', { collection: 'notifications', filters: [{ field: 'createdAt', op: '>=', value: '2026-01-02T00:00:00.000Z' }, { field: 'createdAt', op: '<', value: '2026-01-04T00:00:00.000Z' }], orders: [{ field: 'createdAt', dir: 'asc' }] }, 'dev1'));
  assert.deepEqual(range.docs.map((d) => d.id), ['nq2', 'nq3']);
  const byName = ok(await call('dbQuery', { collection: 'notifications', filters: [{ field: '__name__', op: 'in', value: ['nq1', 'nq5', 'zzz'] }] }, 'dev1'));
  assert.deepEqual(byName.docs.map((d) => d.id), ['nq1', 'nq5']);
  const notIn = ok(await call('dbQuery', { collection: 'notifications', filters: [{ field: 'title', op: 'not-in', value: ['t1', 't2'] }], limit: 10 }, 'dev1'));
  assert.deepEqual(notIn.docs.map((d) => d.id), ['nq3', 'nq4', 'nq5']);
  assert.equal((await call('dbQuery', { collection: 'notifications', filters: [{ field: 'title', op: 'LIKE', value: 'x' }] }, 'dev1')).status, 400);
  assert.equal((await call('dbQuery', { collection: 'Bad Name' }, 'dev1')).status, 400);
  denied(await call('dbQuery', { collection: 'notifications' })); // signed out
  denied(await call('dbQuery', { collection: 'followups' }, 'dev1')); // staff only
  assert.equal(ok(await call('dbQuery', { collection: 'followups' }, 'gd')).docs.length, 0);
  denied(await call('dbQuery', { collection: 'otp_codes' }, 'adm'));
});

test('dbChanges: the change feed reports the collections written since a token', async () => {
  const a = ok(await call('dbChanges', { since: '' }, 'dev1'));
  assert.match(a.seq, /^[a-z0-9]+:\d+$/);
  assert.deepEqual(a.collections, []);
  ok(await call('dbCommit', { writes: [{ type: 'set', path: `notifications/nfeed`, data: { type: 'x', title: 'feed', createdAt: SERVER_TS } }, { type: 'set', path: 'courses/cfeed', data: { title: 'C', sessions: 3, active: true, createdAt: SERVER_TS } }] }, 'adm'));
  const b = ok(await call('dbChanges', { since: a.seq }, 'dev1'));
  assert.deepEqual(b.collections.sort(), ['courses', 'notifications']);
  assert.equal(b.reset, false);
  const c = ok(await call('dbChanges', { since: b.seq }, 'dev1'));
  assert.deepEqual(c.collections, []);
  const r = ok(await call('dbChanges', { since: 'oldboot:5' }, 'dev1'));
  assert.equal(r.reset, true);
  // a denied commit writes nothing, so it does not show up either
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'payments/order_NOPE', data: { userId: 'dev1' } }] }, 'dev1'));
  assert.deepEqual(ok(await call('dbChanges', { since: c.seq }, 'dev1')).collections, []);
});

test('server endpoints on the typed store: createEvent (batch + FK), getEvents, submitSadhana, getSadhanaMe, dbStatus', async () => {
  const created = ok(await call('createEvent', { title: 'Server made', category: 'Kirtans', date: '2026-12-25', time: '18:30', location: 'Temple' }, 'gd'));
  assert.match(created.attendanceToken, /^[0-9A-F]{8}$/);
  const secret = await pool.query('SELECT attendance_token FROM event_secrets WHERE id = $1', [created.eventId]);
  assert.equal(secret.rows[0].attendance_token, created.attendanceToken);
  const events = ok(await call('getEvents', {}));
  assert.ok(events.events.some((e) => e.id === created.eventId && e.time === '18:30'));
  assert.ok(events.events.every((e) => !('attendanceToken' in e)));
  // events made by the server show their guide group
  const ev = ok(await call('dbGet', { path: `events/${created.eventId}` }, 'gd'));
  assert.equal(ev.data.groupId, 'gd');

  const submitted = ok(await call('submitSadhana', { rounds: 20, date: todayIST() }, 'dev2'));
  assert.equal(submitted.streak, 1);
  assert.equal(submitted.score, 18);
  const dup = await call('submitSadhana', { rounds: 20, date: todayIST() }, 'dev2');
  assert.equal(dup.status, 409);
  const mine = ok(await call('getSadhanaMe', {}, 'dev2'));
  assert.equal(mine.profile.score, 18);
  assert.equal(mine.logs.length, 1);

  const status = ok(await call('dbStatus', {}, 'adm'));
  assert.equal(status.backend, 'postgres');
  assert.ok(status.counts.users >= 4);
  assert.equal(status.migration.counts.users, 3);
  assert.equal((await call('dbStatus', {}, 'dev1')).status, 403);
});

test('the browser can never reach a collection that has no policy, typed or not', async () => {
  await appDb.collection('experiment_notes').doc('n1').set({ secret: true });
  denied(await call('dbGet', { path: 'experiment_notes/n1' }, 'adm'));
  denied(await call('dbQuery', { collection: 'experiment_notes' }, 'adm'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'experiment_notes/n2', data: { a: 1 } }] }, 'adm'));
  denied(await call('dbCommit', { writes: [{ type: 'set', path: 'system/seeds', data: { done: [] } }] }, 'adm'));
  await appDb.collection('otp_codes').doc('919876543210').set({ phone: '919876543210', attempts: 0 });
  denied(await call('dbCommit', { writes: [{ type: 'delete', path: 'otp_codes/919876543210' }] }, 'adm'));
  assert.equal((await appDb.collection('otp_codes').doc('919876543210').get()).exists, true);
  assert.equal((await appDb.collection('experiment_notes').doc('n2').get()).exists, false);
});
