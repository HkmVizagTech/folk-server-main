'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { createDatabase } = require('./helpers/db');
const { createPool } = require('../src/db/store/pool');
const { migrate } = require('../src/db/migrator');
const { PgStore, Ts, toJson, matchesFilter } = require('../src/db/pgstore');
const { ChangeFeed } = require('../src/db/store');

const FV = admin.firestore.FieldValue;
const quiet = { info() {}, warn() {}, error() {} };
let dbh;
let db;

before(async () => {
  dbh = await createDatabase();
  const pool = createPool(dbh.url, { max: 2 });
  await migrate(pool, { log: quiet });
  await pool.end();
  db = new PgStore(dbh.url, { max: 12 });
});
after(async () => { await db.close(); await dbh.drop(); });

const sql = async (text, params) => (await db.pool.query(text, params)).rows;
const read = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? toJson(s.data()) : undefined; };
const ids = (snap) => snap.docs.map((d) => d.id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ basics
test('set / get / update / delete with version bumps', async () => {
  const ref = db.collection('users').doc('u_basic');
  assert.equal((await ref.get()).exists, false);
  assert.equal((await ref.get()).data(), undefined);
  await ref.set({ name: 'Asha', streak: 1, extraKey: 'x', tags: ['a'] });
  let snap = await ref.get();
  assert.equal(snap.version, 1);
  assert.deepEqual(toJson(snap.data()), { name: 'Asha', streak: 1, extraKey: 'x', tags: ['a'] });
  assert.ok(snap.createTime && snap.updateTime);
  await ref.update({ streak: 2, city: 'Vizag' });
  snap = await ref.get();
  assert.equal(snap.version, 2);
  assert.deepEqual(toJson(snap.data()), { name: 'Asha', streak: 2, extraKey: 'x', tags: ['a'], city: 'Vizag' });
  // set without merge replaces everything
  await ref.set({ name: 'Replaced' });
  snap = await ref.get();
  assert.equal(snap.version, 3);
  assert.deepEqual(toJson(snap.data()), { name: 'Replaced' });
  assert.equal(snap.createTime.toString(), (await ref.get()).createTime.toString());
  await ref.delete();
  assert.equal((await ref.get()).exists, false);
  await ref.delete(); // deleting a missing doc is fine
});

test('create fails if the document exists; update fails if it does not', async () => {
  const ref = db.collection('users').doc('u_create');
  await ref.create({ name: 'A' });
  await assert.rejects(ref.create({ name: 'B' }), (e) => e.code === 'already-exists');
  assert.equal((await read('users', 'u_create')).name, 'A');
  await assert.rejects(db.collection('users').doc('u_nothing').update({ name: 'x' }), (e) => e.code === 'not-found');
  assert.equal((await db.collection('users').doc('u_nothing').get()).exists, false);
  const added = await db.collection('notifications').add({ title: 'hi', createdAt: FV.serverTimestamp() });
  assert.match(added.id, /^[A-Za-z0-9]{20}$/);
});

test('every document round-trips exactly: types, nulls, unknown keys, nesting', async () => {
  const doc = {
    title: 'T', category: 'Retreats', date: 'Sat, Oct 10, 6:30 PM', dateISO: '2026-10-10T13:00:00.000Z',
    audience: 'residents', attendingCount: 2, declinedCount: 0, img: null, ownerId: 'u1',
    unknown: { deep: [1, 'two', { three: null }], flag: true }, numberString: '12', zero: 0, empty: '', emptyArr: [], emptyObj: {},
  };
  await db.collection('events').doc('rt1').set(doc);
  assert.deepEqual(await read('events', 'rt1'), doc);
  const wrong = { title: 5, dateISO: '2026-10-10', audience: 'nobody', attendingCount: 1.5, declinedCount: -1, status: ['x'] };
  await db.collection('events').doc('rt2').set(wrong);
  assert.deepEqual(await read('events', 'rt2'), wrong);
  const [row] = await sql("SELECT title, date_iso, audience, attending_count, extra FROM events WHERE id = 'rt2'");
  assert.equal(row.title, null);
  assert.equal(row.date_iso, null);
  assert.equal(row.extra.title, 5);
  // a typed value written later takes the column back and clears the extra copy
  await db.collection('events').doc('rt2').update({ title: 'Fixed', attendingCount: 4 });
  const [fixed] = await sql("SELECT title, attending_count, extra FROM events WHERE id = 'rt2'");
  assert.equal(fixed.title, 'Fixed');
  assert.equal(fixed.attending_count, 4);
  assert.equal(Object.keys(fixed.extra).includes('title'), false);
  assert.equal((await read('events', 'rt2')).title, 'Fixed');
});

test('timestamps: exact ISO strings in, exact ISO strings (and Ts) out', async () => {
  const when = new Date('2026-10-10T07:08:09.012Z');
  await db.collection('events').doc('ts1').set({ createdAt: when, dateISO: Ts.fromDate(when), updatedAt: admin.firestore.Timestamp.fromDate(when) });
  const d = (await db.collection('events').doc('ts1').get()).data();
  for (const k of ['createdAt', 'dateISO', 'updatedAt']) {
    assert.equal(String(d[k]), '2026-10-10T07:08:09.012Z');
    assert.equal(d[k].toMillis(), when.getTime());
    assert.ok(d[k] instanceof Ts);
  }
  const [r] = await sql("SELECT doc_created_at FROM events WHERE id = 'ts1'");
  assert.equal(r.doc_created_at.toISOString(), '2026-10-10T07:08:09.012Z');
});

test('numbers: rupees as numeric(12,2), integers, bigint, awkward floats kept exactly', async () => {
  await db.collection('trips').doc('num1').set({ price: 19.99, originalPrice: 1300, advanceAmount: 0.1 + 0.2, capacity: 25 });
  const d = await read('trips', 'num1');
  assert.equal(d.price, 19.99);
  assert.equal(d.advanceAmount, 0.30000000000000004);
  const [r] = await sql("SELECT price, original_price, advance_amount, capacity FROM trips WHERE id = 'num1'");
  assert.deepEqual([r.price, r.original_price, r.advance_amount, r.capacity], [19.99, 1300, null, 25]);
  await db.collection('payments').doc('pn1').set({ amount: 98, amountPaise: 9800, paidAmountPaise: 2 ** 40 });
  assert.equal((await read('payments', 'pn1')).paidAmountPaise, 2 ** 40);
  assert.equal(typeof (await sql("SELECT amount_paise FROM payments WHERE id = 'pn1'"))[0].amount_paise, 'number');
});

// ------------------------------------------------------------------ writes
test('set merge: partial, nested, and on a missing document', async () => {
  const ref = db.collection('users').doc('u_merge');
  await ref.set({ name: 'M', metadata: { location: 'A', source: 'web' }, prefs: { theme: 'dark', n: 1 }, streak: 1 }, { merge: true });
  assert.equal((await ref.get()).version, 1);
  await ref.set({ score: 9, city: 'Z' }, { merge: true }); // top-level only: single statement
  await ref.set({ metadata: { location: 'B' }, prefs: { n: 2 } }, { merge: true }); // nested: deep merge
  assert.deepEqual(await read('users', 'u_merge'), {
    name: 'M', streak: 1, score: 9, city: 'Z', metadata: { location: 'B', source: 'web' }, prefs: { theme: 'dark', n: 2 },
  });
  assert.equal((await ref.get()).version, 3);
  await ref.set({ name: null, streak: FV.delete(), zip: FV.delete() }, { merge: true });
  const d = await read('users', 'u_merge');
  assert.equal(d.name, null);
  assert.equal('streak' in d, false);
  assert.equal('zip' in d, false);
  const rows = await sql("SELECT name, streak, extra FROM users WHERE id = 'u_merge'");
  assert.equal(rows[0].streak, null);
  assert.equal(rows[0].extra.name, null);
});

test('increment: atomic on typed columns, correct under 30 parallel writers', async () => {
  await db.collection('sevas').doc('s_inc').set({ title: 'S', countRegistered: 0, maxVolunteers: 100 });
  await Promise.all(Array.from({ length: 30 }, () => db.collection('sevas').doc('s_inc').update({ countRegistered: FV.increment(1) })));
  assert.equal((await read('sevas', 's_inc')).countRegistered, 30);
  assert.equal((await db.collection('sevas').doc('s_inc').get()).version, 31);
  await db.collection('sevas').doc('s_inc').update({ countRegistered: FV.increment(-5) });
  assert.equal((await read('sevas', 's_inc')).countRegistered, 25);
  // increments on a field that is missing / on an unknown key / on a rupee column
  await db.collection('sevas').doc('s_inc').update({ brandNew: FV.increment(2), ghost: FV.increment(3) });
  await db.collection('sevas').doc('s_inc').update({ brandNew: FV.increment(2) });
  const d = await read('sevas', 's_inc');
  assert.equal(d.brandNew, 4);
  assert.equal(d.ghost, 3);
  await db.collection('trips').doc('t_inc').set({ price: 10 });
  await db.collection('trips').doc('t_inc').update({ price: FV.increment(0.5) });
  assert.equal((await read('trips', 't_inc')).price, 10.5);
  await db.collection('trips').doc('t_inc').update({ price: FV.increment(0.001) }); // not a 2-decimal amount: kept exactly, outside the column
  assert.equal((await read('trips', 't_inc')).price, 10.501);
});

test('increment that would break a CHECK is kept as a value, not an error', async () => {
  await db.collection('sevas').doc('s_neg').set({ countRegistered: 0 });
  await db.collection('sevas').doc('s_neg').update({ countRegistered: FV.increment(-1) });
  assert.equal((await read('sevas', 's_neg')).countRegistered, -1);
  await db.collection('sevas').doc('s_neg').update({ countRegistered: FV.increment(3) }); // back to a legal value: returns to the column
  const [r] = await sql("SELECT count_registered, extra FROM sevas WHERE id = 's_neg'");
  assert.equal(r.count_registered, 2);
  assert.deepEqual(r.extra, {});
});

test('arrayUnion / arrayRemove on a text[] column and on an extra key', async () => {
  const ref = db.collection('trips').doc('t_arr');
  await ref.set({ highlights: ['a'], labels: ['x'] });
  await ref.update({ highlights: FV.arrayUnion('b', 'a'), labels: FV.arrayUnion('y') });
  assert.deepEqual((await read('trips', 't_arr')).highlights, ['a', 'b']);
  assert.deepEqual((await read('trips', 't_arr')).labels, ['x', 'y']);
  await ref.update({ highlights: FV.arrayRemove('a'), newList: FV.arrayUnion({ k: 1 }, { k: 1 }) });
  const d = await read('trips', 't_arr');
  assert.deepEqual(d.highlights, ['b']);
  assert.deepEqual(d.newList, [{ k: 1 }]);
  assert.deepEqual((await sql("SELECT highlights FROM trips WHERE id = 't_arr'"))[0].highlights, ['b']);
  const q = await db.collection('trips').where('highlights', 'array-contains', 'b').get();
  assert.ok(ids(q).includes('t_arr'));
  const qa = await db.collection('trips').where('labels', 'array-contains-any', ['y', 'zzz']).get();
  assert.deepEqual(ids(qa), ['t_arr']);
});

test('serverTimestamp (admin SDK sentinel and wire format) and delete sentinel', async () => {
  const ref = db.collection('users').doc('u_ts');
  await ref.set({ name: 'T', createdAt: FV.serverTimestamp(), lastFollowUpAt: { __op: 'serverTimestamp' }, junk: 1 });
  const d = (await ref.get()).data();
  assert.ok(d.createdAt instanceof Ts);
  assert.ok(Math.abs(d.createdAt.toMillis() - Date.now()) < 5000);
  assert.match(String(d.lastFollowUpAt), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  await ref.update({ updatedAt: FV.serverTimestamp(), junk: FV.delete(), name: { __op: 'delete' } });
  const e = toJson((await ref.get()).data());
  assert.equal('junk' in e, false);
  assert.equal('name' in e, false);
  assert.ok(e.updatedAt);
});

test('dotted-path updates: typed jsonb column, extra object, and a path through a scalar column', async () => {
  const ref = db.collection('users').doc('u_dot');
  await ref.set({ name: 'D', metadata: { location: 'A', source: 'web' }, prefs: { theme: { dark: true }, n: 1 } });
  await ref.update({ 'metadata.location': 'B', 'prefs.theme.dark': false, 'prefs.fresh.deep': 7, 'metadata.source': FV.delete() });
  assert.deepEqual(await read('users', 'u_dot'), { name: 'D', metadata: { location: 'B' }, prefs: { theme: { dark: false }, n: 1, fresh: { deep: 7 } } });
  const [r] = await sql("SELECT metadata, extra FROM users WHERE id = 'u_dot'");
  assert.deepEqual(r.metadata, { location: 'B' });
  assert.deepEqual(r.extra, { prefs: { theme: { dark: false }, n: 1, fresh: { deep: 7 } } });
  await ref.update('city', 'Vizag', 'streak', 3); // update('field', value, ...) form
  assert.equal((await read('users', 'u_dot')).streak, 3);
  // path through a scalar typed column: the scalar is replaced by a map (Firestore does the same), kept in extra
  await ref.update({ 'name.first': 'Dee' });
  assert.deepEqual((await read('users', 'u_dot')).name, { first: 'Dee' });
});

test('unique constraints surface as already-exists and roll the write back', async () => {
  await db.collection('trips').doc('uq1').set({ slug: 'same-slug', title: 'one' });
  await assert.rejects(db.collection('trips').doc('uq2').set({ slug: 'same-slug' }), (e) => e.code === 'already-exists');
  await db.collection('trips').doc('uq2').set({ slug: 'other-slug' });
  await assert.rejects(db.collection('trips').doc('uq2').update({ slug: 'same-slug' }), (e) => e.code === 'already-exists');
  assert.equal((await read('trips', 'uq2')).slug, 'other-slug');
  await assert.rejects(db.collection('trips').doc('uq2').set({ slug: 'same-slug' }, { merge: true }), (e) => e.code === 'already-exists');
  await db.collection('users').doc('uq_u1').set({ qrToken: 'Q1' });
  await assert.rejects(db.collection('users').doc('uq_u2').set({ qrToken: 'Q1' }), (e) => e.code === 'already-exists');
  // composite natural key (event, user) alongside the composite id
  await db.collection('registrations').doc('e1_uA').set({ eventId: 'e1', userId: 'uA', status: 'Attending' });
  await assert.rejects(db.collection('registrations').doc('e1_uA_dup').set({ eventId: 'e1', userId: 'uA' }), (e) => e.code === 'already-exists');
  // not a violation: two docs without a qrToken
  await db.collection('users').doc('uq_n1').set({ name: 'n1' });
  await db.collection('users').doc('uq_n2').set({ name: 'n2' });
});

test('CHECK constraints can never be hit through the store (bad values are kept in extra)', async () => {
  await db.collection('trip_registrations').doc('chk1').set({ seats: 99, status: 'PENDING', paymentMode: 'barter' });
  const d = await read('trip_registrations', 'chk1');
  assert.deepEqual(d, { seats: 99, status: 'PENDING', paymentMode: 'barter' });
  await assert.rejects(sql("INSERT INTO trip_registrations (id, seats) VALUES ('raw', 99)"), (e) => e.code === '23514');
  await assert.rejects(sql("INSERT INTO trip_registrations (id, status) VALUES ('raw', 'weird')"), (e) => e.code === '23514');
});

test('composite and unusual ids', async () => {
  for (const id of ['evt1_uidA', 'manual_6f1c2d3e-aaaa', 'with space', 'ünïcode-ID', 'a'.repeat(300), "quote'quote", 'x%y_z']) {
    await db.collection('attendance').doc(id).set({ userId: 'u', eventId: id, name: id });
    assert.equal((await read('attendance', id)).name, id);
  }
  assert.throws(() => db.collection('attendance').doc('a/b'), /Bad document id/);
  assert.throws(() => db.collection('Bad-Name'), /Bad collection name/);
  assert.equal(db.doc('attendance/evt1_uidA').id, 'evt1_uidA');
});

// ----------------------------------------------------------------- queries
test('queries: ==, !=, ranges, in, not-in, array ops, __name__, limit/offset, count', async () => {
  const E = db.collection('events');
  const mk = (id, d) => E.doc(id).set(d);
  await Promise.all([
    mk('q1', { title: 'A', audience: 'all', attendingCount: 1, dateISO: '2026-01-01T00:00:00.000Z', ownerId: 'o1', tag: 'x', n: 5 }),
    mk('q2', { title: 'B', audience: 'mine', attendingCount: 5, dateISO: '2026-02-01T00:00:00.000Z', ownerId: 'o1', tag: 'y', n: 6 }),
    mk('q3', { title: 'C', audience: 'residents', attendingCount: 9, dateISO: '2026-03-01T00:00:00.000Z', ownerId: 'o2', tag: 'x' }),
    mk('q4', { title: 'D', attendingCount: null, ownerId: null, tag: 'z', n: 7 }),
    mk('q5', { title: 'E', audience: 'weird', attendingCount: '3', ownerId: 'o3' }),
  ]);
  const base = E.where('__name__', 'in', ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual(ids(await base.where('audience', '==', 'all').get()), ['q1']);
  assert.deepEqual(ids(await base.where('audience', '==', 'weird').get()), ['q5']); // value only possible in extra
  assert.deepEqual(ids(await base.where('audience', '!=', 'all').get()), ['q2', 'q3', 'q5']); // q4 has no audience
  assert.deepEqual(ids(await base.where('attendingCount', '>', 1).get()), ['q2', 'q3']);
  assert.deepEqual(ids(await base.where('attendingCount', '>=', 1).where('attendingCount', '<=', 5).get()), ['q1', 'q2']);
  assert.deepEqual(ids(await base.where('attendingCount', '==', '3').get()), ['q5']);
  assert.deepEqual(ids(await base.where('attendingCount', '==', null).get()), ['q4']);
  assert.deepEqual(ids(await base.where('attendingCount', 'in', [1, 9, '3']).get()), ['q1', 'q3', 'q5']);
  assert.deepEqual(ids(await base.where('attendingCount', 'not-in', [1, 9]).get()), ['q2', 'q5']);
  assert.deepEqual(ids(await base.where('audience', 'in', ['all', 'residents', 'weird']).get()), ['q1', 'q3', 'q5']);
  assert.deepEqual(ids(await base.where('audience', 'not-in', ['all']).get()), ['q2', 'q3', 'q5']);
  assert.deepEqual(ids(await base.where('dateISO', '>=', '2026-02-01T00:00:00.000Z').get()), ['q2', 'q3']);
  assert.deepEqual(ids(await base.where('dateISO', '<', Ts.fromDate('2026-02-01T00:00:00.000Z')).get()), ['q1']);
  assert.deepEqual(ids(await base.where('ownerId', '==', 'o1').get()), ['q1', 'q2']);
  assert.deepEqual(ids(await base.where('tag', '==', 'x').get()), ['q1', 'q3']); // unknown field (extra)
  assert.deepEqual(ids(await base.where('n', '>=', 6).get()), ['q2', 'q4']);
  assert.deepEqual(ids(await base.where('n', 'in', [5, 7]).get()), ['q1', 'q4']);
  assert.deepEqual(ids(await base.where('nope', '==', 1).get()), []);
  assert.deepEqual(ids(await E.where('__name__', '==', 'q3').get()), ['q3']);
  assert.deepEqual(ids(await E.where('__name__', '>', 'q3').where('__name__', '<=', 'q5').get()), ['q4', 'q5']);
  assert.deepEqual(ids(await base.where('__name__', '!=', 'q1').where('__name__', 'not-in', ['q2']).get()), ['q3', 'q4', 'q5']);
  // limit / offset / count
  assert.deepEqual(ids(await base.limit(2).get()), ['q1', 'q2']);
  assert.deepEqual(ids(await base.offset(3).limit(5).get()), ['q4', 'q5']);
  assert.equal((await base.where('ownerId', '==', 'o1').count().get()).data().count, 2);
  assert.equal((await base.get()).size, 5);
  assert.equal((await base.where('title', '==', 'zzz').get()).empty, true);
  // JS mirror of the semantics
  assert.equal(matchesFilter({ id: 'x', data: { a: 1 } }, { field: 'a', op: '==', value: 1 }), true);
  assert.equal(matchesFilter({ id: 'x', data: {} }, { field: 'a', op: '!=', value: 1 }), false);
});

test('orderBy: asc/desc, several keys, missing-field rows are dropped, id tie-break', async () => {
  const L = db.collection('sadhana_logs');
  await Promise.all([
    L.doc('o_1').set({ userId: 'ou', date: '2026-10-01', score: 5 }),
    L.doc('o_2').set({ userId: 'ou', date: '2026-10-03', score: 9 }),
    L.doc('o_3').set({ userId: 'ou', date: '2026-10-02', score: 9 }),
    L.doc('o_4').set({ userId: 'ou', score: 1 }), // no date: left out when ordering by date
    L.doc('o_5').set({ userId: 'ou', date: '2026-10-04' }), // no score
  ]);
  const mine = L.where('userId', '==', 'ou');
  assert.deepEqual(ids(await mine.orderBy('date', 'desc').get()), ['o_5', 'o_2', 'o_3', 'o_1']);
  assert.deepEqual(ids(await mine.orderBy('date').limit(2).get()), ['o_1', 'o_3']);
  assert.deepEqual(ids(await mine.orderBy('score', 'desc').orderBy('date', 'asc').get()), ['o_3', 'o_2', 'o_1']); // every orderBy field must be present
  assert.deepEqual(ids(await mine.orderBy('__name__', 'desc').limit(2).get()), ['o_5', 'o_4']);
  assert.deepEqual(ids(await mine.where('date', '>=', '2026-10-02').orderBy('date', 'desc').limit(7).get()), ['o_5', 'o_2', 'o_3']);
  assert.deepEqual(ids(await mine.orderBy('unknownField').get()), []);
  // ordering by an unknown (extra) key
  await L.doc('o_6').set({ userId: 'ou2', rank: 2 });
  await L.doc('o_7').set({ userId: 'ou2', rank: 1 });
  assert.deepEqual(ids(await L.where('userId', '==', 'ou2').orderBy('rank').get()), ['o_7', 'o_6']);
});

test('queries on collections outside the registry (generic table)', async () => {
  const C = db.collection('scratch_notes');
  await C.doc('a').set({ text: 'one', n: 1, when: '2026-01-01T00:00:00.000Z', tags: ['t1'] });
  await C.doc('b').set({ text: 'two', n: 2, nested: { deep: 'yes' } });
  await C.doc('c').set({ text: 'three' });
  await db.collection('other_scratch').doc('a').set({ text: 'elsewhere', n: 1 });
  assert.deepEqual(ids(await C.where('n', '>=', 1).orderBy('n', 'desc').get()), ['b', 'a']);
  assert.deepEqual(ids(await C.where('nested.deep', '==', 'yes').get()), ['b']);
  assert.deepEqual(ids(await C.where('tags', 'array-contains', 't1').get()), ['a']);
  assert.deepEqual(ids(await C.get()), ['a', 'b', 'c']);
  await C.doc('a').update({ n: FV.increment(5), 'nested.k': 1 });
  await C.doc('c').set({ extra: true }, { merge: true });
  assert.deepEqual(await read('scratch_notes', 'a'), { text: 'one', n: 6, when: '2026-01-01T00:00:00.000Z', tags: ['t1'], nested: { k: 1 } });
  assert.deepEqual(await read('scratch_notes', 'c'), { text: 'three', extra: true });
  await C.doc('b').delete();
  assert.equal((await C.get()).size, 2);
  assert.equal((await db.collection('other_scratch').get()).size, 1); // separate collections stay separate
  assert.equal((await C.count().get()).data().count, 2);
});

// ------------------------------------------------------------ transactions
test('runTransaction: read-modify-write is serialised (20 concurrent increments)', async () => {
  await db.collection('events').doc('tx_counter').set({ attendingCount: 0 });
  await Promise.all(Array.from({ length: 20 }, () => db.runTransaction(async (t) => {
    const s = await t.get(db.collection('events').doc('tx_counter'));
    t.update(s.ref, { attendingCount: s.data().attendingCount + 1 }); // absolute value, like the client's RSVP
  })));
  assert.equal((await read('events', 'tx_counter')).attendingCount, 20);
  assert.equal((await db.collection('events').doc('tx_counter').get()).version, 21);
});

test('transaction commits all writes or none', async () => {
  await db.collection('users').doc('tx_a').set({ name: 'A' });
  await assert.rejects(db.runTransaction(async (t) => {
    t.update(db.collection('users').doc('tx_a'), { name: 'A2' });
    t.set(db.collection('users').doc('tx_b'), { name: 'B' });
    t.create(db.collection('users').doc('tx_a'), { name: 'dup' }); // fails
  }), (e) => e.code === 'already-exists');
  assert.equal((await read('users', 'tx_a')).name, 'A');
  assert.equal((await db.collection('users').doc('tx_b').get()).exists, false);
  // an exception thrown by the callback rolls back too, and is passed through
  await assert.rejects(db.runTransaction(async (t) => { t.set(db.collection('users').doc('tx_c'), { n: 1 }); throw new Error('boom'); }), /boom/);
  assert.equal((await db.collection('users').doc('tx_c').get()).exists, false);
  // and a transaction can read a query
  const out = await db.runTransaction(async (t) => (await t.get(db.collection('users').where('name', '==', 'A'))).size);
  assert.ok(out >= 1);
});

test('runTransaction retries on serialization failure / deadlock and gives up after maxAttempts', async () => {
  let attempts = 0;
  const r = await db.runTransaction(async (t) => {
    attempts += 1;
    if (attempts < 3) { const e = new Error('simulated'); e.code = '40001'; throw e; }
    t.set(db.collection('users').doc('tx_retry'), { n: attempts });
    return 'done';
  });
  assert.equal(r, 'done');
  assert.equal(attempts, 3);
  assert.equal((await read('users', 'tx_retry')).n, 3);
  let tries = 0;
  await assert.rejects(db.runTransaction(async () => { tries += 1; const e = new Error('dl'); e.code = '40P01'; throw e; }, { maxAttempts: 2 }), /dl/);
  assert.equal(tries, 2);
});

test('a real deadlock between two transactions is retried and both finish', async () => {
  await db.collection('users').doc('dl_a').set({ n: 0 });
  await db.collection('users').doc('dl_b').set({ n: 0 });
  const run = (first, second) => db.runTransaction(async (t) => {
    await t.get(db.collection('users').doc(first));
    await sleep(80);
    await t.get(db.collection('users').doc(second));
    t.update(db.collection('users').doc(first), { n: FV.increment(1) });
    t.update(db.collection('users').doc(second), { n: FV.increment(1) });
  });
  await Promise.all([run('dl_a', 'dl_b'), run('dl_b', 'dl_a')]);
  assert.equal((await read('users', 'dl_a')).n, 2);
  assert.equal((await read('users', 'dl_b')).n, 2);
});

test('a plain set waits for a transaction that has read the same document', async () => {
  const ref = db.collection('users').doc('lock1');
  await ref.set({ name: 'start' });
  let release;
  const gate = new Promise((r) => { release = r; });
  let read1;
  const txDone = db.runTransaction(async (t) => {
    read1 = (await t.get(ref)).version;
    await gate;
    t.update(ref, { name: 'from-tx' });
  });
  await sleep(100);
  let setDone = false;
  const setP = ref.set({ name: 'from-set' }).then(() => { setDone = true; });
  await sleep(250);
  assert.equal(setDone, false, 'the single write must wait for the lock');
  release();
  await Promise.all([txDone, setP]);
  assert.equal(read1, 1);
  assert.equal((await read('users', 'lock1')).name, 'from-set'); // applied after the transaction
  assert.equal((await ref.get()).version, 3);
  // same for an increment and a delete
  await db.collection('sevas').doc('lock2').set({ countRegistered: 0 });
  release = null;
  let rel2;
  const gate2 = new Promise((r) => { rel2 = r; });
  const tx2 = db.runTransaction(async (t) => { await t.get(db.collection('sevas').doc('lock2')); await gate2; });
  await sleep(100);
  let incDone = false;
  const inc = db.collection('sevas').doc('lock2').update({ countRegistered: FV.increment(1) }).then(() => { incDone = true; });
  await sleep(200);
  assert.equal(incDone, false);
  rel2();
  await Promise.all([tx2, inc]);
  assert.equal((await read('sevas', 'lock2')).countRegistered, 1);
});

test('write batch: many docs in multi-row statements, ordering, atomicity', async () => {
  const b = db.batch();
  for (let i = 0; i < 450; i += 1) b.set(db.collection('notifications').doc(`bn_${String(i).padStart(3, '0')}`), { title: `n${i}`, type: 'new_event', createdAt: '2026-01-01T00:00:00.000Z' });
  await b.commit();
  assert.equal((await db.collection('notifications').where('title', '>=', 'n0').where('type', '==', 'new_event').get()).size, 450);
  // same doc twice in one batch: later write wins; mixed types in order
  const b2 = db.batch();
  const r1 = db.collection('users').doc('bt_1');
  b2.set(r1, { name: 'first' });
  b2.set(r1, { name: 'second' });
  b2.set(db.collection('users').doc('bt_2'), { name: 'two' });
  b2.update(r1, { city: 'X' });
  b2.create(db.collection('users').doc('bt_3'), { name: 'three' });
  b2.delete(db.collection('users').doc('bt_2'));
  await b2.commit();
  assert.deepEqual(await read('users', 'bt_1'), { name: 'second', city: 'X' });
  assert.equal(await read('users', 'bt_2'), undefined);
  assert.equal((await read('users', 'bt_3')).name, 'three');
  // a failing member undoes the whole batch
  const b3 = db.batch();
  b3.set(db.collection('users').doc('bt_4'), { name: 'four' });
  b3.create(db.collection('users').doc('bt_3'), { name: 'dup' });
  await assert.rejects(b3.commit(), (e) => e.code === 'already-exists');
  assert.equal(await read('users', 'bt_4'), undefined);
  // multi-row create conflict inside a group
  const b4 = db.batch();
  b4.create(db.collection('users').doc('bt_5'), { name: 'five' });
  b4.create(db.collection('users').doc('bt_3'), { name: 'dup' });
  await assert.rejects(b4.commit(), (e) => e.code === 'already-exists');
  assert.equal(await read('users', 'bt_5'), undefined);
  assert.deepEqual(await db.batch().commit(), []);
});

test('the only FK: event_secrets -> events (deferred, cascade)', async () => {
  await assert.rejects(db.collection('event_secrets').doc('no_such_event').set({ attendanceToken: 'AAAA1111' }), (e) => e.code === 'failed-precondition');
  // a batch may write the secret before the event (the constraint is deferred to commit)
  const b = db.batch();
  b.set(db.collection('event_secrets').doc('fk_evt'), { attendanceToken: 'BBBB2222', createdAt: FV.serverTimestamp() });
  b.set(db.collection('events').doc('fk_evt'), { title: 'With secret' });
  await b.commit();
  assert.equal((await read('event_secrets', 'fk_evt')).attendanceToken, 'BBBB2222');
  await db.collection('events').doc('fk_evt').delete();
  assert.equal((await db.collection('event_secrets').doc('fk_evt').get()).exists, false); // cascaded
});

test('server-only collections behave: otp merge with delete sentinel, system docs', async () => {
  const ref = db.collection('otp_codes').doc('919000000001');
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    assert.equal(s.exists, false);
    t.set(ref, { code: FV.delete(), codeHash: 'h'.repeat(64), phone: '919000000001', createdAt: admin.firestore.Timestamp.fromMillis(1790000000000), expiresAt: admin.firestore.Timestamp.fromMillis(1790000300000), attempts: 0, sends: [1790000000000] }, { merge: true });
  });
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    assert.equal(s.data().expiresAt.toMillis(), 1790000300000);
    t.update(ref, { attempts: s.data().attempts + 1 });
  });
  await ref.set({ code: FV.delete(), codeHash: FV.delete(), expiresAt: FV.delete() }, { merge: true });
  assert.deepEqual(await read('otp_codes', '919000000001'), { phone: '919000000001', createdAt: new Date(1790000000000).toISOString(), attempts: 1, sends: [1790000000000] });
  await db.collection('system').doc('seeds').set({ done: ['a'], updatedAt: FV.serverTimestamp() }, { merge: true });
  await db.collection('system').doc('seeds').set({ done: ['a', 'b'] }, { merge: true });
  assert.deepEqual((await read('system', 'seeds')).done, ['a', 'b']);
});

// ----------------------------------------------------------------- change feed
test('onWrite fires once per committed write, never for rolled-back ones', async () => {
  const seen = [];
  db.onWrite = (c) => seen.push(`${c.collection}/${c.id}:${c.type}`);
  try {
    await db.collection('users').doc('cf1').set({ n: 1 });
    await db.collection('users').doc('cf1').update({ n: FV.increment(1) });
    await db.collection('users').doc('cf1').set({ m: 1 }, { merge: true });
    await db.collection('users').doc('cf1').delete();
    const b = db.batch();
    b.set(db.collection('events').doc('cf2'), { a: 1 });
    b.set(db.collection('events').doc('cf3'), { a: 1 });
    await b.commit();
    await db.runTransaction(async (t) => { t.set(db.collection('sevas').doc('cf4'), { a: 1 }); });
    await assert.rejects(db.runTransaction(async (t) => { t.set(db.collection('sevas').doc('cf5'), { a: 1 }); throw new Error('no'); }));
    await assert.rejects(db.collection('users').doc('cf1').update({ a: 1 })); // not-found: nothing written
    assert.deepEqual(seen, ['users/cf1:set', 'users/cf1:update', 'users/cf1:set', 'users/cf1:delete', 'events/cf2:set', 'events/cf3:set', 'sevas/cf4:set']);
    db.onWrite = () => { throw new Error('hook failure must not break writes'); };
    await db.collection('users').doc('cf6').set({ ok: true });
    assert.equal((await read('users', 'cf6')).ok, true);
  } finally { db.onWrite = null; }
});

test('ChangeFeed: since-token protocol, reset on unknown boot / overflow', () => {
  const f = new ChangeFeed({ max: 3 });
  const t0 = f.token();
  assert.deepEqual(f.since(''), { seq: t0, collections: [], reset: false });
  f.note('users'); f.note('events'); f.note('users');
  assert.deepEqual(f.since(t0).collections.sort(), ['events', 'users']);
  assert.equal(f.since(f.token()).collections.length, 0);
  assert.equal(f.since('other:1').reset, true);
  assert.equal(f.since('garbage').reset, true);
  f.note('a'); f.note('b'); f.note('c'); f.note('d'); // overflow past max
  assert.equal(f.since(t0).reset, true);
});

// ------------------------------------------------------------------ import
test('importDocuments: modes, version 0 guard, dirty documents', async () => {
  const doc = (id, data, version = 0) => ({ id, data, version, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  let rep = await db.importDocuments('trips', [doc('imp1', { slug: 'imp-1', title: 'A' }), doc('imp2', { slug: 'imp-1', title: 'dup slug', price: 'free' }), doc('imp3', 'not an object')]);
  assert.equal(rep.inserted, 2);
  assert.equal(rep.rejected, 1);
  assert.deepEqual(rep.demoted, { 'trips.slug': 1 });
  assert.equal((await db.collection('trips').doc('imp1').get()).version, 0);
  assert.equal((await db.collection('trips').doc('imp2').get()).createTime.toString(), '2026-01-01T00:00:00.000Z');
  assert.equal((await read('trips', 'imp2')).slug, 'imp-1');
  // a later edit through the app makes the row version 1: the delta copy must not touch it
  await db.collection('trips').doc('imp1').update({ title: 'edited in app' });
  rep = await db.importDocuments('trips', [doc('imp1', { slug: 'imp-1', title: 'from firestore' }), doc('imp2', { slug: 'imp-1', title: 'refreshed' })], { mode: 'guard0' });
  assert.equal((await read('trips', 'imp1')).title, 'edited in app');
  assert.equal((await read('trips', 'imp2')).title, 'refreshed');
  await db.importDocuments('trips', [doc('imp1', { slug: 'imp-1', title: 'forced' })], { mode: 'overwrite' });
  assert.equal((await read('trips', 'imp1')).title, 'forced');
  assert.equal((await db.collection('trips').doc('imp1').get()).version, 0);
  rep = await db.importDocuments('mystery', [doc('m1', { a: 1 })]);
  assert.equal(rep.inserted, 1);
  assert.equal((await read('mystery', 'm1')).a, 1);
});

test('listCollections includes every typed table', async () => {
  const names = (await db.listCollections()).map((c) => c.id);
  for (const n of ['users', 'events', 'event_secrets', 'trips', 'otp_codes', 'system', 'scratch_notes']) assert.ok(names.includes(n), n);
  assert.throws(() => db.doc('x/y').collection(), /Subcollections/);
});
