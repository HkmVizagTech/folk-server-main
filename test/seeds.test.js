'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');

let dbh;
let db;
let pool;

before(async () => {
  dbh = await createDatabase();
  process.env.DATABASE_URL = dbh.url;
  delete process.env.DATA_BACKEND;
  ({ db } = require('../src/config/firebase'));
  pool = db.pool;
  const { migrate } = require('../src/db/migrator');
  await migrate(pool, { log: { info() {}, warn() {}, error() {} } });
});
after(async () => { await db.close(); await dbh.drop(); });

test('the Srikurmam seed writes a fully typed trip once, and is safe to run again', async () => {
  const { runSeeds } = require('../src/db/seeds');
  await runSeeds();
  await runSeeds();
  const { rows } = await pool.query("SELECT slug, price, original_price, advance_amount, capacity, status, registration_open, online_payment_enabled, cash_payment_enabled, start_date, end_date, highlights, inclusions, gallery, itinerary, doc_created_at, extra FROM trips");
  assert.equal(rows.length, 1);
  const t = rows[0];
  assert.equal(t.slug, 'srikurmam-yatra');
  assert.deepEqual([t.price, t.original_price, t.advance_amount, t.capacity], [49, 1300, 0, 25]);
  assert.deepEqual([t.status, t.registration_open, t.online_payment_enabled, t.cash_payment_enabled], ['upcoming', true, true, false]);
  assert.deepEqual([t.start_date, t.end_date], ['2026-10-10', '2026-10-10']);
  assert.equal(t.highlights.length, 6);
  assert.deepEqual(t.gallery, []);
  assert.deepEqual(t.itinerary, []);
  assert.ok(t.doc_created_at instanceof Date);
  assert.deepEqual(t.extra, {}); // every seeded field has a typed column
  const seeds = (await db.collection('system').doc('seeds').get()).data();
  assert.deepEqual(seeds.done, ['srikurmam-yatra-2026-10-10']);
});
