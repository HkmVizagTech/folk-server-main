'use strict';

/**
 * Known-issue fixes, end to end over HTTP against a throwaway Postgres:
 *   trip capacity (migration 003 triggers + store error mapping + policies),
 *   sadhana forgery policies (with the real client transaction shapes),
 *   shared stage derivation, getEvents audience filtering.
 * Auth is stubbed: "Bearer uid:<uid>".
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabase } = require('./helpers/db');
const { createPool } = require('../src/db/store/pool');
const { migrate, DIR } = require('../src/db/migrator');

let dbh;
let server;
let base;
let appDb;
let pool;

const quiet = { info() {}, warn() {}, error() {} };
const call = async (fn, data, uid) => {
  const res = await fetch(`${base}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer uid:${uid}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json() };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
const denied = (r) => { assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.error.code, 'permission-denied'); };
const full = (r) => {
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'failed-precondition');
  assert.match(r.body.error.message, /^This yatra is full/);
};
const SERVER_TS = { __op: 'serverTimestamp' };

const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const todayIST = () => istDate(new Date());
const yesterdayIST = () => istDate(new Date(Date.now() - 86400000));
const daysAgoIST = (n) => istDate(new Date(Date.now() - n * 86400000));
const tomorrowIST = () => istDate(new Date(Date.now() + 86400000));

const get = async (p, uid) => ok(await call('dbGet', { path: p }, uid)).data;
const commit = (writes, uid, preconditions) => call('dbCommit', { writes, ...(preconditions ? { preconditions } : {}) }, uid);

before(async () => {
  dbh = await createDatabase();

  // 001 + 002 first, with rows in the shapes legacy data has, so migration 003's backfill is tested on them.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folk-mig003-'));
  fs.copyFileSync(path.join(DIR, '001_typed_schema.sql'), path.join(tmp, '001_typed_schema.sql'));
  fs.writeFileSync(path.join(tmp, '002_import_legacy_documents.js'), 'module.exports = { up: async () => ({}) };'); // nothing to import here
  pool = createPool(dbh.url, { max: 4 });
  await migrate(pool, { dir: tmp, log: quiet });
  await pool.query(`INSERT INTO "system" (id, source, completed_at) VALUES ('migration', 'firestore', '2026-01-01T00:00:00.000Z')`); // the Firestore copy already happened
  fs.rmSync(tmp, { recursive: true, force: true });
  await pool.query(`INSERT INTO trips (id, slug, title, capacity) VALUES ('legacyTrip', 'legacy', 'Legacy', 10), ('legacyStr', 'legacy-str', 'Legacy str', NULL), ('emptyTrip', 'empty', 'Empty', 5)`);
  await pool.query(`UPDATE trips SET extra = '{"capacity": "40"}' WHERE id = 'legacyStr'`);
  await pool.query(`INSERT INTO trip_registrations (id, trip_id, user_id, seats, status, extra) VALUES
    ('l1', 'legacyTrip', 'u1', 2, 'confirmed', '{}'),
    ('l2', 'legacyTrip', 'u2', 1, 'pending', '{}'),
    ('l3', 'legacyTrip', 'u3', 4, 'cancelled', '{}'),
    ('l4', 'legacyTrip', 'u4', NULL, NULL, '{"seats": "3", "status": "Pending"}'),
    ('l5', 'legacyTrip', 'u5', NULL, 'pending', '{}'),
    ('l6', 'legacyStr', 'u6', 7, 'confirmed', '{}')`);

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
  ({ db: appDb } = require('../src/config/firebase'));
  const database = require('../src/services/database.service');
  await database.init(); // applies 003
  assert.equal(database.getError(), null);
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const users = [
    ['adm', 'admin', {}], ['gd', 'folks_head', {}], ['gd2', 'folks_head', {}],
    ['dev1', 'devotee', { streak: 0, score: 0 }], ['dev2', 'devotee', {}],
    ['mem1', 'devotee', { guideId: 'gd', level: 'Initiated', phone: '9876500001' }],
    ['mem2', 'devotee', { level: 'FOLK New', phone: '9876500002' }],
    ['mem3', 'devotee', { level: 'Pre-Initiated', phone: '9876500003' }],
    ['res1', 'devotee', { stage: 'resident', phone: '9876500004' }],
    ['num1', 'devotee', { level: '4', phone: '9876500005' }],
  ];
  for (const [uid, role, extra] of users) await appDb.collection('users').doc(uid).set({ uid, name: uid, role, ...extra });
  for (let i = 1; i <= 12; i += 1) await appDb.collection('users').doc(`b${i}`).set({ uid: `b${i}`, name: `b${i}`, role: 'devotee' });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await appDb.close();
  await pool.end();
  await dbh.drop();
});

// ------------------------------------------------------------- trip capacity
test('003: seats_taken is backfilled from legacy rows (typed columns and values kept in extra)', async () => {
  const seats = Object.fromEntries((await pool.query('SELECT id, seats_taken FROM trips')).rows.map((r) => [r.id, r.seats_taken]));
  // l1 2 + l2 1 + l4 "3" (extra, status "Pending") + l5 (no seats = 1); the cancelled l3 holds nothing
  assert.equal(seats.legacyTrip, 7);
  assert.equal(seats.legacyStr, 7);
  assert.equal(seats.emptyTrip, 0);
  assert.equal((await get('trips/legacyTrip')).seatsTaken, 7);
  assert.equal((await get('trips/legacyTrip')).capacity, 10);
});

const newTrip = async (id, capacity) => {
  ok(await commit([{ type: 'create', path: `trips/${id}`, data: { slug: id, title: id, status: 'upcoming', ...(capacity === undefined ? {} : { capacity }), createdAt: SERVER_TS } }], 'adm'));
};
const book = (uid, tripId, seats, id) => commit([{ type: 'create', path: `trip_registrations/${id || `${uid}_${tripId}`}`, data: { tripId, userId: uid, seats, status: 'pending', amountDue: 100, paymentOrderId: null, createdAt: SERVER_TS } }], uid);
const taken = async (tripId) => (await get(`trips/${tripId}`)).seatsTaken;

test('bookings fill the trip up to capacity, then fail with failed-precondition "This yatra is full"', async () => {
  await newTrip('cap5', 5);
  assert.equal(await taken('cap5'), 0);
  ok(await book('b1', 'cap5', 2));
  assert.equal(await taken('cap5'), 2);
  assert.equal(await get('trips/cap5').then((t) => t.seatsTaken), 2, 'readable by anyone, also signed out');
  ok(await call('dbGet', { path: 'trips/cap5' })); // no uid
  const tooMany = await book('b2', 'cap5', 4);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'failed-precondition');
  assert.match(tooMany.body.error.message, /^This yatra is full: only 3 seats left$/);
  assert.equal((await call('dbGet', { path: 'trip_registrations/b2_cap5' }, 'b2')).body.result.exists, false);
  ok(await book('b2', 'cap5', 3));
  assert.equal(await taken('cap5'), 5);
  full(await book('b3', 'cap5', 1));
  assert.equal(await taken('cap5'), 5);

  // a devotee cancels their own pending booking: the seats come back
  ok(await commit([{ type: 'update', path: 'trip_registrations/b2_cap5', data: { status: 'cancelled', updatedAt: SERVER_TS } }], 'b2'));
  assert.equal(await taken('cap5'), 2);
  ok(await book('b3', 'cap5', 1));
  assert.equal(await taken('cap5'), 3);
  // detail edits and staff confirming take no extra seat
  ok(await commit([{ type: 'update', path: 'trip_registrations/b1_cap5', data: { status: 'confirmed', updatedAt: SERVER_TS } }], 'gd'));
  assert.equal(await taken('cap5'), 3);
  ok(await commit([{ type: 'update', path: 'trip_registrations/b1_cap5', data: { pickup: 'Station', updatedAt: SERVER_TS } }], 'b1'));
  // a cancelled booking cannot be revived by staff into a full trip, but fits once there is room
  ok(await book('b4', 'cap5', 2));
  assert.equal(await taken('cap5'), 5);
  full(await commit([{ type: 'update', path: 'trip_registrations/b2_cap5', data: { status: 'pending', updatedAt: SERVER_TS } }], 'adm'));
  assert.equal(await taken('cap5'), 5);
  // staff cancelling (reducing seats) is never blocked
  ok(await commit([{ type: 'update', path: 'trip_registrations/b4_cap5', data: { status: 'cancelled', updatedAt: SERVER_TS } }], 'gd'));
  assert.equal(await taken('cap5'), 3);
  ok(await commit([{ type: 'delete', path: 'trip_registrations/b3_cap5' }], 'adm'));
  assert.equal(await taken('cap5'), 2);
});

test('no capacity (missing, 0) means unlimited', async () => {
  await newTrip('nocap');
  await newTrip('zerocap', 0);
  for (const t of ['nocap', 'zerocap']) {
    ok(await book('b1', t, 20));
    ok(await book('b2', t, 20));
    assert.equal(await taken(t), 40);
  }
});

test('legacy rows: overfull trips still allow cancelling and confirming; string capacity is honoured', async () => {
  // legacyTrip: capacity 10, 7 taken. 3 more fits, 4 does not.
  full(await book('b1', 'legacyTrip', 4, 'x1'));
  ok(await book('b1', 'legacyTrip', 3, 'x2'));
  assert.equal(await taken('legacyTrip'), 10);
  // a booking that was pending can be confirmed (same seats) and cancelled on a full trip
  ok(await commit([{ type: 'update', path: 'trip_registrations/l2', data: { status: 'confirmed' } }], 'adm'));
  ok(await commit([{ type: 'update', path: 'trip_registrations/l1', data: { status: 'cancelled' } }], 'adm'));
  assert.equal(await taken('legacyTrip'), 8);
  // lower-cased comparison of the legacy "Pending" row that lives in extra
  ok(await commit([{ type: 'update', path: 'trip_registrations/l4', data: { status: 'cancelled' } }], 'adm'));
  assert.equal(await taken('legacyTrip'), 5);
  // capacity stored as text "40" in extra, 7 taken: 34 fit, 34 more do not
  ok(await book('b1', 'legacyStr', 20, 'y1'));
  ok(await book('b1', 'legacyStr', 13, 'y3'));
  full(await book('b2', 'legacyStr', 1, 'y2'));
  assert.equal(await taken('legacyStr'), 40);
});

test('seatsTaken cannot be written by clients: devotees are refused, staff values are refused or ignored', async () => {
  denied(await commit([{ type: 'update', path: 'trips/cap5', data: { seatsTaken: 0 } }], 'b1'));
  denied(await commit([{ type: 'create', path: 'trips/evil', data: { slug: 'evil', seatsTaken: 0 } }], 'b1'));
  denied(await commit([{ type: 'update', path: 'trips/cap5', data: { seatsTaken: 0 } }], 'gd')); // 2 taken: a different value
  denied(await commit([{ type: 'create', path: 'trips/evil2', data: { slug: 'evil2', seatsTaken: 5 } }], 'adm'));
  ok(await commit([{ type: 'update', path: 'trips/cap5', data: { title: 'Renamed', seatsTaken: 2 } }], 'gd')); // unchanged value: harmless
  ok(await commit([{ type: 'update', path: 'trips/cap5', data: { capacity: 8, updatedAt: SERVER_TS } }], 'gd'));
  assert.equal(await taken('cap5'), 2);
  // even straight through the store (server code), the column is derived
  await appDb.collection('trips').doc('cap5').set({ slug: 'cap5', title: 'Replaced', capacity: 8, seatsTaken: 999 });
  assert.equal(await taken('cap5'), 2);
  await appDb.collection('trips').doc('cap5').update({ seatsTaken: 1 });
  assert.equal(await taken('cap5'), 2);
  await pool.query("UPDATE trips SET seats_taken = 77 WHERE id = 'cap5'"); // even SQL cannot lie: the trigger recomputes it
  assert.equal(await taken('cap5'), 2);
  await assert.rejects(pool.query("ALTER TABLE trips DISABLE TRIGGER trips_seats_guard; UPDATE trips SET seats_taken = -1 WHERE id = 'cap5'"), /trips_seats_taken_chk|violates check/);
  await pool.query('ALTER TABLE trips ENABLE TRIGGER trips_seats_guard');
  // raising the capacity gives room again
  ok(await book('b5', 'cap5', 6));
  full(await book('b6', 'cap5', 1));
});

test('concurrent bookings racing for the last seats never oversell (real Postgres)', async () => {
  await newTrip('race3', 3);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => book(`b${i + 1}`, 'race3', 1)));
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status !== 200);
  assert.equal(won.length, 3);
  lost.forEach(full);
  assert.equal(await taken('race3'), 3);
  const { rows } = await pool.query("SELECT sum(seats)::int n FROM trip_registrations WHERE trip_id = 'race3'");
  assert.equal(rows[0].n, 3);

  // the last seat: a 2-seat and a 1-seat booking at once with 2 left in a trip of 4 (one booked)
  await newTrip('race4', 4);
  ok(await book('b1', 'race4', 2));
  const [a, b, c] = await Promise.all([book('b2', 'race4', 2), book('b3', 'race4', 1), book('b4', 'race4', 1)]);
  const wonSeats = [[a, 2], [b, 1], [c, 1]].filter(([r]) => r.status === 200).reduce((n, [, s]) => n + s, 0);
  assert.ok(wonSeats <= 2 && wonSeats >= 1, `won ${wonSeats}`);
  assert.equal(await taken('race4'), 2 + wonSeats);
  assert.ok((await taken('race4')) <= 4);

  // cancellations racing with bookings keep the counter equal to the real sum
  await newTrip('race5', 6);
  ok(await book('b1', 'race5', 3));
  const mix = await Promise.all([
    commit([{ type: 'update', path: 'trip_registrations/b1_race5', data: { status: 'cancelled' } }], 'adm'),
    ...[2, 3, 4, 5, 6, 7, 8].map((i) => book(`b${i}`, 'race5', 1)),
  ]);
  mix.filter((r) => r.status !== 200).forEach(full);
  const real = (await pool.query("SELECT COALESCE(sum(seats),0)::int n FROM trip_registrations WHERE trip_id = 'race5' AND status IN ('pending','confirmed')")).rows[0].n;
  assert.equal(await taken('race5'), real);
  assert.ok(real <= 6);
});

test('a booking is noted in the change feed for trips as well', async () => {
  const since = ok(await call('dbChanges', {}, 'b1')).seq;
  await newTrip('feed', 9);
  ok(await book('b1', 'feed', 1));
  const ch = ok(await call('dbChanges', { since }, 'b1'));
  assert.ok(ch.collections.includes('trips') && ch.collections.includes('trip_registrations'));
});

// ------------------------------------------------------------------ sadhana
const loggedShape = (uid, date, over = {}) => ({ userId: uid, date, target: 16, roundsCompleted: 0, progressPercentage: 0, streak: 0, score: 0, status: 'locked', createdAt: SERVER_TS, ...over });

test('sadhana: the real client transactions (vow, then rounds) still pass, including streak bonuses', async () => {
  const today = todayIST();
  const yesterday = yesterdayIST();
  // day 1 of a fresh devotee: exactly what createTargetTx / logRoundsTx send
  ok(await commit([{ type: 'set', path: `sadhana_logs/dev1_${today}`, data: loggedShape('dev1', today) }], 'dev1'));
  ok(await commit([
    { type: 'update', path: `sadhana_logs/dev1_${today}`, data: { roundsCompleted: 16, progressPercentage: 100, streak: 1, score: 42, completed: true, updatedAt: SERVER_TS } },
    { type: 'update', path: 'users/dev1', data: { streak: 1, longestStreak: 1, score: 42, lastSadhanaDate: today, lastCompletedSadhanaDate: today, updatedAt: SERVER_TS } },
  ], 'dev1'));
  // correcting down takes today's credit away again
  ok(await commit([
    { type: 'update', path: `sadhana_logs/dev1_${today}`, data: { roundsCompleted: 8, progressPercentage: 50, streak: 0, score: 16, completed: false, updatedAt: SERVER_TS } },
    { type: 'update', path: 'users/dev1', data: { streak: 0, longestStreak: 1, score: 16, lastSadhanaDate: today, lastCompletedSadhanaDate: null, updatedAt: SERVER_TS } },
  ], 'dev1'));

  // a member on a 2-day chain reaches day 3: +20 bonus
  await appDb.collection('users').doc('dev2').update({ streak: 2, longestStreak: 2, score: 100, lastSadhanaDate: yesterday, lastCompletedSadhanaDate: yesterday });
  ok(await commit([{ type: 'set', path: `sadhana_logs/dev2_${today}`, data: loggedShape('dev2', today, { target: 24, streak: 2 }) }], 'dev2'));
  // too much for this log: 24 rounds hits the target (48 + 10) and day 3 adds 20 = 78
  denied(await commit([
    { type: 'update', path: `sadhana_logs/dev2_${today}`, data: { roundsCompleted: 24, progressPercentage: 100, streak: 3, score: 79, completed: true } },
    { type: 'update', path: 'users/dev2', data: { streak: 3, longestStreak: 3, score: 179, lastSadhanaDate: today, lastCompletedSadhanaDate: today } },
  ], 'dev2'));
  ok(await commit([
    { type: 'update', path: `sadhana_logs/dev2_${today}`, data: { roundsCompleted: 24, progressPercentage: 100, streak: 3, score: 78, completed: true, updatedAt: SERVER_TS } },
    { type: 'update', path: 'users/dev2', data: { streak: 3, longestStreak: 3, score: 178, lastSadhanaDate: today, lastCompletedSadhanaDate: today, updatedAt: SERVER_TS } },
  ], 'dev2'));
  assert.equal((await get('users/dev2', 'dev2')).score, 178);
});

test('sadhana: forged logs are refused', async () => {
  const today = todayIST();
  const mk = (uid, id, data) => commit([{ type: 'set', path: `sadhana_logs/${id}`, data }], uid);
  denied(await mk('b1', `b1_${today}`, loggedShape('someoneElse', today)));                       // userId != uid
  denied(await mk('b1', `b2_${today}`, loggedShape('b1', today)));                                // id for another user
  denied(await mk('b1', `b1_${today}_x`, loggedShape('b1', today)));                              // id not uid_date
  denied(await mk('b1', `b1_${daysAgoIST(5)}`, loggedShape('b1', daysAgoIST(5))));                // too old
  denied(await mk('b1', `b1_${tomorrowIST()}`, loggedShape('b1', tomorrowIST())));                // future
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { score: 500 })));                // pre-scored vow
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { roundsCompleted: 16, completed: true })));
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { target: 1 })));                 // trivial target
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { streak: 40 })));                // chain it does not have
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { roundsCompleted: 65 })));
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { roundsCompleted: 1.5 })));
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { score: -1 })));
  denied(await mk('b1', `b1_${today}`, loggedShape('b1', today, { score: '10' })));
  // a valid vow, then forgeries on the update
  ok(await mk('b1', `b1_${today}`, loggedShape('b1', today)));
  denied(await commit([{ type: 'delete', path: `sadhana_logs/b1_${today}` }], 'b1')); // only admins delete
  const up = (data, uid = 'b1') => commit([{ type: 'update', path: `sadhana_logs/b1_${today}`, data }], uid);
  denied(await up({ roundsCompleted: 16, completed: true, streak: 1, score: 9999 }));
  denied(await up({ roundsCompleted: 16, completed: true, streak: 1, score: 43 }));               // formula: 32 + 10
  denied(await up({ roundsCompleted: 16, completed: true, streak: 5, score: 42 }));               // streak jump
  denied(await up({ roundsCompleted: 70, completed: true, streak: 1, score: 150 }));
  denied(await up({ roundsCompleted: 8, completed: true, streak: 1, score: 26 }));                // completed below target
  denied(await up({ roundsCompleted: 16, completed: false, score: 32 }));                          // done but not marked
  denied(await up({ target: 8, roundsCompleted: 8, completed: true, streak: 1, score: 26 }));     // vow lowered afterwards
  denied(await up({ userId: 'b2' }));
  denied(await up({ date: yesterdayIST() }));
  denied(await up({ roundsCompleted: 4, score: 8 }, 'b2'));                                        // someone else's log
  ok(await up({ roundsCompleted: 5, progressPercentage: 31, score: 10, updatedAt: SERVER_TS }));
});

test('sadhana: owners cannot inflate their own profile summary', async () => {
  const today = todayIST();
  const upUser = (data, uid = 'b3') => commit([{ type: 'update', path: `users/${uid}`, data }], uid);
  denied(await upUser({ score: 5000 }));
  denied(await upUser({ streak: 50, longestStreak: 50 }));
  denied(await upUser({ streak: 1 }));                                                              // a +1 needs a completed log in the commit
  denied(await upUser({ score: 40, lastSadhanaDate: today }));                                      // no log
  denied(await upUser({ longestStreak: 9 }));
  denied(await upUser({ score: -3 }));
  denied(await upUser({ lastSadhanaDate: '2020-01-01' }));
  ok(await commit([{ type: 'set', path: `sadhana_logs/b3_${today}`, data: loggedShape('b3', today) }], 'b3'));
  // log says 10 points, profile claims 500
  denied(await commit([
    { type: 'update', path: `sadhana_logs/b3_${today}`, data: { roundsCompleted: 5, score: 10, progressPercentage: 31 } },
    { type: 'update', path: 'users/b3', data: { score: 500, lastSadhanaDate: today } },
  ], 'b3'));
  // log completes, profile streak jumps by 5
  denied(await commit([
    { type: 'update', path: `sadhana_logs/b3_${today}`, data: { roundsCompleted: 16, score: 42, streak: 1, completed: true } },
    { type: 'update', path: 'users/b3', data: { streak: 5, longestStreak: 5, score: 42, lastSadhanaDate: today, lastCompletedSadhanaDate: today } },
  ], 'b3'));
  // honest
  ok(await commit([
    { type: 'update', path: `sadhana_logs/b3_${today}`, data: { roundsCompleted: 16, score: 42, streak: 1, completed: true } },
    { type: 'update', path: 'users/b3', data: { streak: 1, longestStreak: 1, score: 42, lastSadhanaDate: today, lastCompletedSadhanaDate: today } },
  ], 'b3'));
  // ordinary profile edits are untouched
  ok(await upUser({ city: 'Vizag', updatedAt: SERVER_TS }));
  // staff-managed and role fields stay locked, and a self-created profile starts at zero
  denied(await upUser({ stage: 'resident' }));
  denied(await commit([{ type: 'create', path: 'users/newbie', data: { uid: 'newbie', role: 'devotee', score: 900 } }], 'newbie'));
  ok(await commit([{ type: 'create', path: 'users/newbie', data: { uid: 'newbie', role: 'devotee', streak: 0, score: 0 } }], 'newbie'));
});

// ------------------------------------------------------------------- stages
test('stage derivation understands the level labels the client writes (one shared module)', async () => {
  const { stageOf } = require('../src/utils/stages');
  const policies = require('../src/db/policies');
  const broadcasts = require('../src/services/broadcast.service');
  assert.equal(policies.stageOf, stageOf);
  const cases = [
    [{ level: 'FOLK New' }, 'new'], [{ level: ' folk enhanced ' }, 'regular'], [{ level: 'Pre-Initiated' }, 'practising'],
    [{ level: 'Initiated' }, 'committed'], [{ level: '5' }, 'resident'], [{ level: 3 }, 'practising'],
    [{ level: 'unknown label' }, 'new'], [{}, 'new'], [null, 'new'],
    [{ stage: 'resident', level: 'FOLK New' }, 'resident'], [{ stage: 'bogus', level: 'Initiated' }, 'committed'],
  ];
  for (const [u, want] of cases) assert.equal(stageOf(u), want, JSON.stringify(u));

  // broadcast-by-stage picks the same people the UI shows
  const phones = async (stage) => (await broadcasts.resolveRecipients({ uid: 'adm' }, 'stage', stage)).sort();
  assert.deepEqual(await phones('committed'), ['919876500001', '919876500005']); // 'Initiated' and numeric level 4
  assert.deepEqual(await phones('new'), ['919876500002']);
  assert.deepEqual(await phones('practising'), ['919876500003']);
  assert.deepEqual(await phones('resident'), ['919876500004']);
  assert.deepEqual(await phones('regular'), []);
});

test('canSeeEvent(residents) uses the derived stage, not only a numeric level', async () => {
  const dataApi = require('../src/db/dataApi');
  const policies = require('../src/db/policies');
  const ctxOf = (uid) => dataApi.loadCtx({ auth: { uid } });
  assert.equal((await ctxOf('mem1')).stage, 'committed');
  assert.equal((await ctxOf('num1')).stage, 'committed');
  assert.equal(policies.canSeeEvent(await ctxOf('mem1'), { audience: 'residents', ownerId: 'gd' }), false);
  assert.equal(policies.canSeeEvent(await ctxOf('res1'), { audience: 'residents', ownerId: 'gd' }), true);
});

// ---------------------------------------------------------------- getEvents
test('getEvents applies the same audience filtering as /dbQuery; createEvent can set an audience', async () => {
  const mk = (id, extra) => appDb.collection('events').doc(id).set({ title: id, category: 'Kirtans', date: '2026-12-25', ...extra });
  await mk('evPublic', { audience: 'all', ownerId: 'adm' });
  await mk('evOld', {}); // no audience = public
  await mk('evMine', { audience: 'mine', ownerId: 'gd' });
  await mk('evRes', { audience: 'residents', ownerId: 'gd2' });
  const ids = async (uid) => ok(await call('getEvents', {}, uid)).events.map((e) => e.id);
  const pub = await ids();
  assert.ok(pub.includes('evPublic') && pub.includes('evOld'));
  assert.ok(!pub.includes('evMine') && !pub.includes('evRes'));
  const mem = await ids('mem1'); // gd's member, not resident
  assert.ok(mem.includes('evMine') && !mem.includes('evRes'));
  const other = await ids('mem2');
  assert.ok(!other.includes('evMine') && !other.includes('evRes'));
  const res = await ids('res1');
  assert.ok(res.includes('evRes') && !res.includes('evMine'));
  const owner = await ids('gd');
  assert.ok(owner.includes('evMine') && owner.includes('evRes')); // residents events are open to staff
  const adminIds = await ids('adm');
  assert.ok(adminIds.includes('evMine') && adminIds.includes('evRes'));

  // createEvent: audience is optional and validated like the policy
  const made = ok(await call('createEvent', { title: 'Private kirtan', category: 'Kirtans', date: '2026-12-26', audience: 'mine' }, 'gd'));
  const stored = await appDb.collection('events').doc(made.eventId).get();
  assert.equal(stored.data().audience, 'mine');
  assert.equal(stored.data().ownerId, 'gd');
  assert.ok(!(await ids()).includes(made.eventId));
  assert.ok((await ids('mem1')).includes(made.eventId));
  const bad = await call('createEvent', { title: 'x', category: 'y', date: 'z', audience: 'all' }, 'gd');
  assert.equal(bad.status, 400);
  assert.equal((await call('createEvent', { title: 'x', category: 'y', date: 'z', audience: 'nobody' }, 'adm')).status, 400);
  const everyone = ok(await call('createEvent', { title: 'Public', category: 'y', date: 'z', audience: 'all' }, 'adm'));
  assert.ok((await ids()).includes(everyone.eventId));
  // no audience: unchanged behaviour (public)
  const plain = ok(await call('createEvent', { title: 'Plain', category: 'y', date: 'z' }, 'gd'));
  assert.ok((await ids()).includes(plain.eventId));
});
