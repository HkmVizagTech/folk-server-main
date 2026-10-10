'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');
const { createPool } = require('../src/db/store/pool');
const { migrate } = require('../src/db/migrator');
const { PgStore } = require('../src/db/pgstore');
const { listSchemas, getSchema } = require('../src/db/schema');
const { tableSql } = require('../src/db/schema/ddl');

const quiet = { info() {}, warn() {}, error() {} };
let dbh;
let db;

before(async () => {
  dbh = await createDatabase();
  const pool = createPool(dbh.url, { max: 2 });
  await migrate(pool, { log: quiet });
  await pool.end();
  db = new PgStore(dbh.url, { max: 4 });
});
after(async () => { await db.close(); await dbh.drop(); });

const sql = async (text, params) => (await db.pool.query(text, params)).rows;

const PG_TYPE = {
  text: 'text', int: 'integer', bigint: 'bigint', numeric: 'numeric', bool: 'boolean',
  ts: 'timestamp with time zone', date: 'date', textArray: 'ARRAY', jsonb: 'jsonb',
};

test('registry: 23 typed collections, every table has the bookkeeping columns', async () => {
  assert.equal(listSchemas().length, 23);
  for (const s of listSchemas()) {
    const cols = await sql("SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [s.table]);
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    for (const c of s.columns) {
      const got = byName.get(c.name);
      assert.ok(got, `${s.table}.${c.name} missing in the database`);
      assert.equal(got.data_type, PG_TYPE[c.type], `${s.table}.${c.name} type`);
      assert.equal(got.is_nullable, c.derived ? 'NO' : 'YES', `${s.table}.${c.name} nullability (absent keys are representable; derived columns are NOT NULL DEFAULT 0)`);
      if (c.type === 'numeric') assert.deepEqual([got.numeric_precision, got.numeric_scale], [12, 2]);
    }
    const expected = new Set(['id', 'extra', 'version', 'created_at', 'updated_at', ...s.columns.map((c) => c.name)]);
    assert.deepEqual([...byName.keys()].sort(), [...expected].sort(), `${s.table}: database and src/db/schema disagree`);
    for (const n of ['id', 'extra', 'version', 'created_at', 'updated_at']) assert.equal(byName.get(n).is_nullable, 'NO', `${s.table}.${n} NOT NULL`);
  }
});

test('constraints, indexes and the FK exist as declared', async () => {
  const cons = new Set((await sql("SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace")).map((r) => r.conname));
  const idx = new Set((await sql("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).map((r) => r.indexname));
  for (const s of listSchemas()) {
    assert.ok(cons.has(`${s.table}_pkey`), `${s.table} pk`);
    assert.ok(cons.has(`${s.table}_extra_object_chk`));
    for (const u of s.unique) assert.ok(cons.has(u.name), `unique ${u.name}`);
    for (const i of s.indexes) assert.ok(idx.has(i.name), `index ${i.name}`);
    for (const f of s.foreignKeys) assert.ok(cons.has(f.name), `fk ${f.name}`);
    for (const c of s.columns) if (c.enum || c.min !== undefined || c.max !== undefined) assert.ok(cons.has(`${s.table}_${c.name}_chk`.slice(0, 63)), `check ${s.table}.${c.name}`);
  }
  // exactly one foreign key in the whole schema
  const fks = await sql("SELECT conname, confdeltype, condeferrable, condeferred FROM pg_constraint WHERE contype = 'f'");
  assert.equal(fks.length, 1);
  assert.deepEqual(fks[0], { conname: 'event_secrets_id_fkey', confdeltype: 'c', condeferrable: true, condeferred: true });
  assert.match(tableSql(getSchema('users')), /CREATE TABLE "users"/);
});

test('natural keys declared UNIQUE match the composite ids', () => {
  const uniq = (c) => getSchema(c).unique.map((u) => u.columns.join('+'));
  assert.deepEqual(uniq('registrations'), ['event_id+user_id']);
  assert.deepEqual(uniq('attendance'), ['event_id+user_id']);
  assert.deepEqual(uniq('prasadam_logs'), ['event_id+user_id']);
  assert.deepEqual(uniq('sadhana_logs'), ['user_id+log_date']);
  assert.deepEqual(uniq('seva_registrations'), ['user_id+seva_id']);
  assert.deepEqual(uniq('enrollments'), ['course_id+user_id']);
  assert.deepEqual(uniq('trips'), ['slug']);
  assert.deepEqual(uniq('users'), ['qr_token']);
});

// One entry per query shape the inventory lists. Each must be answerable from an index.
const SHAPES = [
  ['users', (q) => q.where('phoneNormalized', '==', '919876543210')],
  ['users', (q) => q.where('phone', '==', '+91 98765 43210')],
  ['users', (q) => q.where('guideId', '==', 'g1')],
  ['users', (q) => q.where('role', '==', 'admin')],
  ['users', (q) => q.where('qrToken', '==', 'FOLK-1')],
  ['users', (q) => q.where('uid', '==', 'u1')],
  ['events', (q) => q.where('ownerId', '==', 'o1')],
  ['events', (q) => q.where('audience', '==', 'mine')],
  ['events', (q) => q.orderBy('dateISO')],
  ['registrations', (q) => q.where('userId', '==', 'u1')],
  ['registrations', (q) => q.where('token', '==', 'AB12CD34')],
  ['registrations', (q) => q.where('eventId', '==', 'e1')],
  ['attendance', (q) => q.where('eventId', '==', 'e1')],
  ['attendance', (q) => q.where('userId', '==', 'u1')],
  ['attendance', (q) => q.orderBy('createdAt', 'desc').limit(1500)],
  ['attendance', (q) => q.where('createdAt', '>=', '2026-01-01T00:00:00.000Z').orderBy('createdAt', 'desc')],
  ['prasadam_logs', (q) => q.where('userId', '==', 'u1')],
  ['prasadam_logs', (q) => q.orderBy('timestamp', 'desc').limit(50)],
  ['sadhana_logs', (q) => q.where('userId', '==', 'u1').where('date', '==', '2026-10-10')],
  ['sadhana_logs', (q) => q.where('userId', '==', 'u1').orderBy('date', 'desc').limit(7)],
  ['sevas', (q) => q.orderBy('date')],
  ['seva_registrations', (q) => q.where('userId', '==', 'u1')],
  ['seva_registrations', (q) => q.where('sevaId', '==', 's1')],
  ['trips', (q) => q.where('slug', '==', 'srikurmam-yatra')],
  ['trips', (q) => q.orderBy('startDate')],
  ['trip_registrations', (q) => q.where('userId', '==', 'u1')],
  ['trip_registrations', (q) => q.where('tripId', '==', 't1')],
  ['trip_registrations', (q) => q.where('tripId', '==', 't1').where('status', '==', 'confirmed')],
  ['trip_registrations', (q) => q.where('paymentOrderId', '==', 'order_1')],
  ['payments', (q) => q.where('userId', '==', 'u1')],
  ['payments', (q) => q.where('tripRegistrationId', '==', 'r1')],
  ['payments', (q) => q.where('status', '==', 'pending')],
  ['accommodation_requests', (q) => q.orderBy('createdAt', 'desc')],
  ['accommodation_requests', (q) => q.where('userId', '==', 'u1').orderBy('createdAt', 'desc')],
  ['accommodation_requests', (q) => q.where('status', '==', 'pending')],
  ['accommodation_requests', (q) => q.where('userId', '==', 'u1').where('status', '==', 'approved')],
  ['hostel_bookings', (q) => q.orderBy('createdAt', 'desc')],
  ['hostel_bookings', (q) => q.where('userId', '==', 'u1').orderBy('createdAt', 'desc')],
  ['hostel_bookings', (q) => q.where('listingId', '==', 'l1')],
  ['hostel_bookings', (q) => q.where('status', '==', 'pending')],
  ['enrollments', (q) => q.where('userId', '==', 'u1')],
  ['enrollments', (q) => q.where('courseId', '==', 'c1')],
  ['followups', (q) => q.where('memberId', '==', 'u1')],
  ['followups', (q) => q.where('guideId', '==', 'g1')],
  ['followups', (q) => q.where('createdAt', '>=', '2026-01-01T00:00:00.000Z')],
  ['notifications', (q) => q.orderBy('createdAt', 'desc').limit(10)],
  ['contact_messages', (q) => q.orderBy('createdAt')],
  ['broadcasts', (q) => q.orderBy('createdAt', 'desc')],
  ['otp_codes', (q) => q.where('expiresAt', '<', '2026-01-01T00:00:00.000Z')],
];

const indexNames = (node, out = []) => {
  if (node['Index Name']) out.push(node['Index Name']);
  for (const p of node.Plans || []) indexNames(p, out);
  return out;
};

test('every query shape of the inventory can use an index', async () => {
  // some data so the planner has statistics; indexes are made eligible by disabling seq scans
  const b = db.batch();
  for (let i = 0; i < 300; i += 1) b.set(db.collection('users').doc(`perf_${i}`), { name: `n${i}`, phoneNormalized: `91${i}`, role: 'devotee', guideId: `g${i % 7}` });
  await b.commit();
  await sql('ANALYZE');
  const client = await db.pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    for (const [collection, build] of SHAPES) {
      const { text, params } = build(db.collection(collection))._sql();
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, params);
      const names = indexNames(rows[0]['QUERY PLAN'][0].Plan);
      assert.ok(names.length > 0, `${collection}: no index used for\n${text}`);
    }
  } finally {
    client.release();
  }
});

test('bulk write and indexed lookups stay fast', async () => {
  const started = Date.now();
  const b = db.batch();
  for (let i = 0; i < 2000; i += 1) {
    const user = `bulk${i % 40}`;
    const date = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 40))).toISOString().slice(0, 10);
    b.set(db.collection('sadhana_logs').doc(`${user}_${date}`), { userId: user, date, roundsCompleted: i % 17, score: i % 90 });
  }
  await b.commit();
  const wrote = Date.now() - started;
  const t = Date.now();
  const snap = await db.collection('sadhana_logs').where('userId', '==', 'bulk7').orderBy('date', 'desc').limit(7).get();
  assert.equal(snap.size, 7);
  assert.ok(Date.now() - t < 500);
  assert.ok(wrote < 20000, `bulk write took ${wrote} ms`);
});
