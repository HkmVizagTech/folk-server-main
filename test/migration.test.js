'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');
const { createLegacyTables } = require('./helpers/legacy');
const { FIXTURES, EXPECTED_REJECTS } = require('./helpers/fixtures');
const { createPool } = require('../src/db/store/pool');
const { migrate, status } = require('../src/db/migrator');
const { PgStore, toJson } = require('../src/db/pgstore');
const { typedCollections } = require('../src/db/schema');

const quiet = { info() {}, warn() {}, error() {} };
let dbh;
let pool;
let store;
let stamps;
let result;

before(async () => {
  dbh = await createDatabase();
  pool = createPool(dbh.url, { max: 3 });
  stamps = await createLegacyTables(pool);
  result = await migrate(pool, { log: quiet });
  store = new PgStore(dbh.url, { max: 3 });
});

after(async () => {
  await store.close();
  await pool.end();
  await dbh.drop();
});

const rejected = (c, id) => EXPECTED_REJECTS.some(([rc, rid]) => rc === c && rid === id);

test('both migrations applied and recorded', async () => {
  assert.deepEqual(result.applied.map((m) => m.version), ['001', '002', '003']);
  const { rows } = await pool.query('SELECT version, name, checksum, details FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)));
  const totals = rows[1].details.totals;
  assert.equal(totals.rejected, EXPECTED_REJECTS.length);
  assert.ok(totals.demoted >= 3, `demoted ${totals.demoted}`);
  assert.ok(totals.diverted > 20, `diverted ${totals.diverted}`);
  const total = Object.values(FIXTURES).reduce((n, d) => n + d.length, 0);
  assert.equal(totals.read, total);
  assert.equal(totals.inserted, total - EXPECTED_REJECTS.length);
});

test('every legacy document reads back deep-equal through the new store', async () => {
  let checked = 0;
  for (const [collection, docs] of Object.entries(FIXTURES)) {
    for (const d of docs) {
      if (rejected(collection, d.id)) continue;
      const snap = await store.collection(collection).doc(d.id).get();
      assert.ok(snap.exists, `${collection}/${d.id} missing`);
      const got = toJson(snap.data());
      if (collection === 'trips') { // migration 003 adds the derived seatsTaken to every trip
        assert.ok(Number.isInteger(got.seatsTaken) && got.seatsTaken >= 0, `${d.id} seatsTaken`);
        delete got.seatsTaken;
      }
      assert.deepEqual(got, d.data, `${collection}/${d.id} differs`);
      const st = stamps[`${collection}/${d.id}`];
      assert.equal(snap.version, st.version, `${collection}/${d.id} version`);
      assert.equal(snap.createTime.toString(), st.created, `${collection}/${d.id} created_at`);
      assert.equal(snap.updateTime.toString(), st.updated, `${collection}/${d.id} updated_at`);
      checked += 1;
    }
  }
  assert.ok(checked > 50, `only ${checked} documents checked`);
});

test('timestamps come back as the exact ISO string and revive as Ts', async () => {
  const d = (await store.collection('events').doc('evt1').get()).data();
  assert.equal(String(d.dateISO), '2026-10-11T13:00:00.000Z');
  assert.equal(typeof d.dateISO.toMillis, 'function');
  assert.equal(d.date, 'Sun, Oct 11, 6:30 PM'); // label stays text
  const t = (await store.collection('trips').doc('trip1').get()).data();
  assert.equal(t.startDate, '2026-10-10'); // date-only stays a plain string
  assert.equal(typeof t.startDate.toMillis, 'undefined');
});

test('clean documents land in typed columns, leftovers in extra', async () => {
  const u = (await pool.query("SELECT * FROM users WHERE id = 'uidDev1'")).rows[0];
  assert.equal(u.streak, 4);
  assert.equal(u.dob, '2001-05-17');
  assert.equal(u.stage, 'regular');
  assert.equal(u.guide_id, 'uidGuide1');
  assert.equal(u.doc_created_at.toISOString(), '2026-01-02T03:04:05.678Z');
  assert.deepEqual(u.metadata, { location: 'Vizag', source: 'web' });
  assert.deepEqual(u.extra, {});
  const m = (await pool.query("SELECT extra FROM users WHERE id LIKE 'manual_%'")).rows[0];
  assert.deepEqual(m.extra, { hobby: 'mridanga', tags: ['a', 'b'], prefs: { theme: 'dark', n: 3 } });
  const trip = (await pool.query("SELECT price, original_price, gallery, itinerary FROM trips WHERE id = 'trip1'")).rows[0];
  assert.equal(trip.price, 49);
  assert.equal(trip.original_price, 1300);
  assert.deepEqual(trip.gallery, []);
  assert.deepEqual(trip.itinerary, [{ day: 1, title: 'Travel', details: 'Bus' }]);
  const pay = (await pool.query("SELECT amount, amount_paise FROM payments WHERE id = 'order_DON001'")).rows[0];
  assert.equal(pay.amount, 501.5);
  assert.equal(pay.amount_paise, 50150);
  const reg = (await pool.query("SELECT event_id, user_id, token FROM registrations WHERE id = 'evt1_uidDev1'")).rows[0];
  assert.deepEqual(reg, { event_id: 'evt1', user_id: 'uidDev1', token: 'AB12CD34' });
});

test('dirty values are kept (in extra), never dropped or coerced', async () => {
  const u = (await pool.query("SELECT * FROM users WHERE id = 'dirtyUser'")).rows[0];
  assert.equal(u.streak, null);
  assert.equal(u.extra.streak, '7');
  assert.equal(u.extra.role, 'superuser');
  assert.equal(u.extra.dob, '2000-02-30');
  assert.equal(u.extra.email, null);
  assert.equal(u.extra.createdAt, 1700000000000);
  assert.equal(u.name, null);
  assert.equal(u.extra.name, 12345);
  const t2 = (await pool.query("SELECT original_price, extra FROM trips WHERE id = 'trip2'")).rows[0];
  assert.equal(t2.original_price, null);
  assert.equal(t2.extra.originalPrice, 0.1 + 0.2);
  const p = (await pool.query("SELECT paid_amount_paise, extra FROM payments WHERE id = 'order_OLD'")).rows[0];
  assert.equal(p.paid_amount_paise, null);
  assert.equal(p.extra.paidAmountPaise, 9007199254740992);
});

test('natural-key duplicates keep their documents; the clashing key moves to extra', async () => {
  const slugs = (await pool.query("SELECT id, slug, extra FROM trips WHERE id IN ('trip2', 'trip3') ORDER BY id")).rows;
  assert.equal(slugs[0].slug, 'arunachala');
  assert.equal(slugs[1].slug, null);
  assert.equal(slugs[1].extra.slug, 'arunachala');
  const qr = (await pool.query("SELECT id, qr_token, extra FROM users WHERE id IN ('uidAdmin1', 'dupQrUser') ORDER BY id")).rows;
  assert.equal(qr.filter((r) => r.qr_token === 'qr-0001').length, 1);
  assert.equal(qr.filter((r) => r.extra.qrToken === 'qr-0001').length, 1);
  const reg = (await pool.query("SELECT id, event_id, user_id, extra FROM registrations WHERE id LIKE 'evt1_uidDev1%' ORDER BY id")).rows;
  assert.equal(reg[0].event_id, 'evt1');
  assert.equal(reg[1].event_id, null);
  assert.equal(reg[1].extra.eventId, 'evt1');
});

test('an orphan event_secrets row is rejected into migration_rejects, with its data', async () => {
  const { rows } = await pool.query('SELECT migration, collection, doc_id, data, error FROM migration_rejects');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].collection, 'event_secrets');
  assert.equal(rows[0].doc_id, 'evtDeletedLongAgo');
  assert.deepEqual(rows[0].data, FIXTURES.event_secrets[1].data);
  assert.match(rows[0].error, /foreign key/i);
  assert.equal((await store.collection('event_secrets').doc('evtDeletedLongAgo').get()).exists, false);
});

test('legacy tables are renamed, kept, and never dropped; row counts match', async () => {
  const names = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
  for (const [collection, docs] of Object.entries(FIXTURES)) {
    assert.ok(names.includes(`legacy_${collection}`), `legacy_${collection} missing`);
    const legacy = (await pool.query(`SELECT count(*)::int n FROM "legacy_${collection}"`)).rows[0].n;
    assert.equal(legacy, docs.length);
    const lost = docs.filter((d) => rejected(collection, d.id)).length;
    const now = typedCollections().includes(collection)
      ? (await pool.query(`SELECT count(*)::int n FROM "${collection}"`)).rows[0].n
      : (await pool.query('SELECT count(*)::int n FROM docs_other WHERE collection = $1', [collection])).rows[0].n;
    assert.equal(now, docs.length - lost, `${collection} count`);
  }
  // the typed tables have no `data` column any more
  const { rows } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'data'");
  assert.equal(rows.length, 0);
  // legacy indexes were renamed out of the way
  const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'legacy_users'")).rows.map((r) => r.indexname);
  assert.ok(idx.every((n) => n.startsWith('legacy_')), idx.join(','));
});

test('collections outside the registry use docs_other', async () => {
  const snap = await store.collection('experiment_notes').doc('note1').get();
  assert.deepEqual(toJson(snap.data()), FIXTURES.experiment_notes[0].data);
  const q = await store.collection('experiment_notes').where('text', '==', 'hello').get();
  assert.equal(q.size, 1);
  const cols = (await store.listCollections()).map((c) => c.id);
  assert.ok(cols.includes('experiment_notes'));
  assert.ok(cols.includes('users'));
});

test('migrated data is queryable through typed columns', async () => {
  const logs = await store.collection('sadhana_logs').where('userId', '==', 'uidDev1').orderBy('date', 'desc').limit(7).get();
  assert.deepEqual(logs.docs.map((d) => d.id), ['uidDev1_2026-10-09', 'uidDev1_2026-10-08', 'uidDev1_2026-10-07']);
  const regs = await store.collection('registrations').where('userId', '==', 'uidDev1').get();
  assert.ok(regs.docs.some((d) => d.id === 'evt1_uidDev1'));
  const guide = await store.collection('users').where('guideId', '==', 'uidGuide1').get();
  assert.deepEqual(guide.docs.map((d) => d.id), ['uidDev1']);
  const t = await store.collection('trips').where('startDate', '>=', '2026-11-01').get();
  assert.deepEqual(t.docs.map((d) => d.id), ['trip2']);
});

test('migrations are idempotent and the state is reported', async () => {
  const again = await migrate(pool, { log: quiet });
  assert.equal(again.upToDate, true);
  const st = await status(pool);
  assert.ok(st.every((m) => m.applied && !m.changed));
  const n = (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
  assert.equal(n, FIXTURES.users.length);
});

test('unique natural keys are enforced for new writes', async () => {
  await assert.rejects(
    store.collection('trips').doc('newTrip').set({ slug: 'srikurmam-yatra', title: 'again' }),
    (e) => e.code === 'already-exists' && e.pgCode === '23505');
  // the document must not have been written
  assert.equal((await store.collection('trips').doc('newTrip').get()).exists, false);
});
