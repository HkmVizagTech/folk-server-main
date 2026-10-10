'use strict';

/**
 * Versioned schema migrations.
 *
 *   src/db/migrations/NNN_name.sql   plain SQL, run in one transaction
 *   src/db/migrations/NNN_name.js    module.exports = { up: async (client, ctx) => details }
 *
 * Applied versions are recorded in schema_migrations (version, name, checksum,
 * applied_at, duration_ms, details). A session-level advisory lock makes
 * concurrent starts (two Railway replicas, a script plus the server) take
 * turns; the second one finds everything applied and does nothing. Each
 * migration commits or rolls back as a whole.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{3,})_([a-z0-9_]+)\.(sql|js)$/;
const LOCK_SQL = "SELECT pg_advisory_lock(hashtextextended('folk:schema_migrations', 0))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended('folk:schema_migrations', 0))";

const listMigrations = (dir = DIR) => {
  const out = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().map((file) => {
    const [, version, name, ext] = file.match(FILE_RE);
    const body = fs.readFileSync(path.join(dir, file));
    return { version, name, ext, file, checksum: crypto.createHash('sha256').update(body).digest('hex') };
  });
  const seen = new Set();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`Two migrations share version ${m.version}`);
    seen.add(m.version);
  }
  return out;
};

const ensureTable = (client) => client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    duration_ms integer,
    details jsonb
  )`);

/** Which migrations are applied / pending (read-only; creates nothing). */
const status = async (pool, { dir = DIR } = {}) => {
  const all = listMigrations(dir);
  const { rows: t } = await pool.query("SELECT to_regclass('schema_migrations') AS t");
  const applied = new Map();
  if (t[0].t) {
    const { rows } = await pool.query('SELECT version, name, checksum, applied_at FROM schema_migrations');
    rows.forEach((r) => applied.set(r.version, r));
  }
  return all.map((m) => ({ ...m, applied: applied.has(m.version), appliedAt: applied.get(m.version)?.applied_at || null,
    changed: applied.has(m.version) && applied.get(m.version).checksum !== m.checksum }));
};

/**
 * Apply every pending migration in order. Returns { applied: [{version, name, ms, details}], upToDate }.
 * `pool` is a pg Pool whose type parsers are the store's (see store/pool.js).
 */
const migrate = async (pool, { dir = DIR, log = console } = {}) => {
  const client = await pool.connect();
  const applied = [];
  try {
    // Long data steps must not be cut off by the pool's per-statement timeouts.
    await client.query('SET statement_timeout = 0');
    await client.query('SET idle_in_transaction_session_timeout = 0');
    await client.query(LOCK_SQL);
    await ensureTable(client);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    for (const m of listMigrations(dir)) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.checksum) log.warn(`[migrate] ${m.file} changed after it was applied (checksum differs); not re-run.`);
        continue;
      }
      const started = Date.now();
      log.info(`[migrate] applying ${m.file} ...`);
      try {
        await client.query('BEGIN');
        let details = null;
        if (m.ext === 'sql') {
          await client.query(fs.readFileSync(path.join(dir, m.file), 'utf8'));
        } else {
          const mod = require(path.join(dir, m.file));
          details = (await mod.up(client, { log })) || null;
        }
        const ms = Date.now() - started;
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, duration_ms, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [m.version, m.name, m.checksum, ms, details ? JSON.stringify(details) : null]);
        await client.query('COMMIT');
        applied.push({ version: m.version, name: m.name, ms, details });
        log.info(`[migrate] applied ${m.file} in ${ms} ms`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        e.message = `Migration ${m.file} failed: ${e.message}`;
        throw e;
      }
    }
  } finally {
    await client.query(UNLOCK_SQL).catch(() => {});
    client.release();
  }
  return { applied, upToDate: applied.length === 0 };
};

module.exports = { migrate, status, listMigrations, DIR };
