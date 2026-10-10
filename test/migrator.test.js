'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabase } = require('./helpers/db');
const { createPool } = require('../src/db/store/pool');
const { migrate, status, listMigrations } = require('../src/db/migrator');

const quiet = { info() {}, warn() {}, error() {} };
let dbh;
let pool;
let dir;

before(async () => {
  dbh = await createDatabase();
  pool = createPool(dbh.url, { max: 6 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folk-mig-'));
});
after(async () => { await pool.end(); await dbh.drop(); fs.rmSync(dir, { recursive: true, force: true }); });

const put = (name, body) => fs.writeFileSync(path.join(dir, name), body);

test('the shipped migrations are numbered and uniquely versioned', () => {
  const list = listMigrations();
  assert.deepEqual(list.map((m) => m.file), ['001_typed_schema.sql', '002_import_legacy_documents.js']);
});

test('concurrent runners take turns: each migration is applied exactly once', async () => {
  put('001_a.sql', 'CREATE TABLE m_a (id int); SELECT pg_sleep(0.3);');
  put('002_b.js', "module.exports = { up: async (c) => { await c.query('CREATE TABLE m_b (id int)'); return { note: 'js step' }; } };");
  const runs = await Promise.all([1, 2, 3, 4].map(() => migrate(pool, { dir, log: quiet })));
  const applied = runs.flatMap((r) => r.applied.map((m) => m.version));
  assert.deepEqual(applied.sort(), ['001', '002']);
  assert.equal(runs.filter((r) => r.upToDate).length, 3);
  const { rows } = await pool.query('SELECT version, name, details FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), ['001', '002']);
  assert.deepEqual(rows[1].details, { note: 'js step' });
});

test('a failing migration rolls back completely, is reported by name, and later runs retry it', async () => {
  put('003_bad.sql', 'CREATE TABLE m_c (id int); INSERT INTO m_c VALUES (1); SELECT 1/0;');
  await assert.rejects(migrate(pool, { dir, log: quiet }), /003_bad\.sql failed: division by zero/);
  assert.equal((await pool.query("SELECT to_regclass('m_c') AS t")).rows[0].t, null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n, 2);
  const st = await status(pool, { dir });
  assert.deepEqual(st.map((m) => [m.version, m.applied]), [['001', true], ['002', true], ['003', false]]);
  put('003_bad.sql', 'CREATE TABLE m_c (id int);');
  const r = await migrate(pool, { dir, log: quiet });
  assert.deepEqual(r.applied.map((m) => m.version), ['003']);
});

test('an applied file that was edited is flagged, not re-run', async () => {
  put('001_a.sql', 'CREATE TABLE m_a_changed (id int);');
  const warnings = [];
  const r = await migrate(pool, { dir, log: { info() {}, error() {}, warn: (m) => warnings.push(m) } });
  assert.equal(r.upToDate, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /001_a\.sql changed/);
  assert.equal((await status(pool, { dir })).find((m) => m.version === '001').changed, true);
  assert.equal((await pool.query("SELECT to_regclass('m_a_changed') AS t")).rows[0].t, null);
});

test('two files with one version number are refused', () => {
  put('004_x.sql', 'SELECT 1;');
  put('004_y.sql', 'SELECT 1;');
  assert.throws(() => listMigrations(dir), /share version 004/);
  fs.rmSync(path.join(dir, '004_x.sql'));
  fs.rmSync(path.join(dir, '004_y.sql'));
});
