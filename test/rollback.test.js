'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');
const { createLegacyTables } = require('./helpers/legacy');
const { FIXTURES, EXPECTED_REJECTS } = require('./helpers/fixtures');
const { createPool } = require('../src/db/store/pool');
const { migrate } = require('../src/db/migrator');
const { rollbackToGeneric } = require('../src/db/rollback');
const { PgStore, toJson } = require('../src/db/pgstore');

const quiet = { info() {}, warn() {}, error() {} };
let dbh;
let pool;

before(async () => {
  dbh = await createDatabase();
  pool = createPool(dbh.url, { max: 3 });
});
after(async () => { await pool.end(); await dbh.drop(); });

const snapshotAll = async (store) => {
  const out = {};
  for (const [c, docs] of Object.entries(FIXTURES)) {
    for (const d of docs) {
      const s = await store.collection(c).doc(d.id).get();
      out[`${c}/${d.id}`] = s.exists ? toJson(s.data()) : null;
    }
  }
  return out;
};

test('rollback restores the generic tables with every write made since the migration; migrating again is lossless', async () => {
  await createLegacyTables(pool);
  await migrate(pool, { log: quiet });
  let store = new PgStore(dbh.url, { max: 3 });
  // life after the migration: edits, a new document, a deletion, a new generic doc
  await store.collection('users').doc('uidDev1').update({ streak: 5, city: 'Hyderabad' });
  await store.collection('trips').doc('tripNew').set({ slug: 'new-trip', title: 'New', price: 10.5 });
  await store.collection('notifications').doc('n1').delete();
  await store.collection('experiment_notes').doc('note2').set({ text: 'later' });
  const before = await snapshotAll(store);
  const extra = {
    tripNew: toJson((await store.collection('trips').doc('tripNew').get()).data()),
    note2: toJson((await store.collection('experiment_notes').doc('note2').get()).data()),
  };
  await store.close();

  await rollbackToGeneric(pool, { log: quiet });

  // old shape is back: (id, data, version, created_at, updated_at), with current content
  const users = (await pool.query("SELECT id, data, version FROM users WHERE id = 'uidDev1'")).rows[0];
  assert.equal(users.data.streak, 5);
  assert.equal(users.data.city, 'Hyderabad');
  assert.equal(Number(users.version), 6); // 5 on the legacy row (third user: 3 + 2) + the update
  assert.deepEqual((await pool.query("SELECT data FROM trips WHERE id = 'tripNew'")).rows[0].data, extra.tripNew);
  assert.equal((await pool.query("SELECT count(*)::int n FROM notifications")).rows[0].n, 0); // deleted since
  assert.deepEqual((await pool.query("SELECT data FROM experiment_notes WHERE id = 'note2'")).rows[0].data, extra.note2);
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ['id', 'data', 'version', 'created_at', 'updated_at']);
  // the documents the migration rejected are still in their generic table
  for (const [c, id] of EXPECTED_REJECTS) assert.equal((await pool.query(`SELECT count(*)::int n FROM "${c}" WHERE id = $1`, [id])).rows[0].n, 1);
  // typed tables kept, bookkeeping reset, nothing dropped
  assert.equal((await pool.query("SELECT to_regclass('typed_backup_users') AS t")).rows[0].t, 'typed_backup_users');
  assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 0);
  assert.equal((await pool.query("SELECT to_regclass('legacy_users') AS t")).rows[0].t, null);

  // forward again from the restored generic tables: same documents as before the rollback
  const again = await migrate(pool, { log: quiet });
  assert.deepEqual(again.applied.map((m) => m.version), ['001', '002', '003']);
  store = new PgStore(dbh.url, { max: 3 });
  assert.deepEqual(await snapshotAll(store), before);
  assert.deepEqual(toJson((await store.collection('trips').doc('tripNew').get()).data()), extra.tripNew);
  assert.deepEqual(toJson((await store.collection('experiment_notes').doc('note2').get()).data()), extra.note2);
  await store.close();
});
