'use strict';

/**
 * Go back from the typed schema to the old generic tables, KEEPING every write
 * made since the migration, so the previous release can run again.
 *
 * In one transaction, for every collection that has a legacy_<name> table:
 *   1. legacy_<name> is brought up to date from the typed table (upsert of
 *      every current document; rows deleted since are removed; documents that
 *      migration 002 had to reject are left alone),
 *   2. the typed table is renamed typed_backup_<name> (with its constraints
 *      and indexes), and legacy_<name> becomes <name> again,
 *   3. docs_other / migration_rejects are set aside the same way and the
 *      schema_migrations rows are removed, so a later deploy of the typed
 *      release simply migrates again from the restored generic tables.
 * Nothing is dropped; typed_backup_* tables stay for inspection.
 */
const { getAdapter } = require('./store/codec');
const { typedCollections, GENERIC_TABLE } = require('./schema');

const PAGE = 1000;
const q = (n) => `"${n}"`;

const renameObjects = async (client, table, newName, oldPrefix, newPrefix) => {
  await client.query(`ALTER TABLE ${q(table)} RENAME TO ${q(newName)}`);
  const swap = (n) => (oldPrefix && n.startsWith(oldPrefix) ? n.slice(oldPrefix.length) : n);
  const { rows: cons } = await client.query('SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass', [q(newName)]);
  for (const { conname } of cons) {
    await client.query(`ALTER TABLE ${q(newName)} RENAME CONSTRAINT ${q(conname)} TO ${q(`${newPrefix}${swap(conname)}`)}`);
  }
  const { rows: idx } = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1", [newName]);
  for (const { indexname } of idx) {
    const target = `${newPrefix}${swap(indexname)}`;
    if (target !== indexname) await client.query(`ALTER INDEX ${q(indexname)} RENAME TO ${q(target)}`);
  }
};

const exists = async (client, table) => (await client.query('SELECT to_regclass($1) AS t', [q(table)])).rows[0].t !== null;

const refreshLegacy = async (client, collection, typed) => {
  const adapter = getAdapter(collection);
  const legacy = q(`legacy_${collection}`);
  const src = typed ? q(collection) : q(GENERIC_TABLE);
  const idCol = q(typed ? 'id' : 'doc_id');
  const scope = (alias) => (typed ? 'true' : `${alias}.collection = '${collection}'`); // names match NAME_RE: safe to inline
  let last = null;
  let n = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT ${adapter.selectList} FROM ${src} t WHERE ${scope('t')} AND ($1::text IS NULL OR ${idCol} COLLATE "C" > $1) ORDER BY ${idCol} COLLATE "C" LIMIT ${PAGE}`, [last]);
    if (!rows.length) break;
    await client.query(
      `INSERT INTO ${legacy} (id, data, version, created_at, updated_at)
       SELECT * FROM unnest($1::text[], $2::jsonb[], $3::bigint[], $4::timestamptz[], $5::timestamptz[])
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [rows.map((r) => r.id), rows.map((r) => JSON.stringify(adapter.decode(r))), rows.map((r) => r.version), rows.map((r) => r.created_at), rows.map((r) => r.updated_at)]);
    n += rows.length;
    last = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }
  // documents deleted since the migration (but not those the migration rejected)
  await client.query(
    `DELETE FROM ${legacy} l WHERE NOT EXISTS (SELECT 1 FROM ${src} s WHERE ${scope('s')} AND s.${idCol} = l.id)
       AND NOT EXISTS (SELECT 1 FROM migration_rejects r WHERE r.collection = $1 AND r.doc_id = l.id)`, [collection]);
  return n;
};

/** Run the rollback. `pool` is a pg Pool. Returns { collections: {name: rows}, kept: [...] }. */
const rollbackToGeneric = async (pool, { log = console } = {}) => {
  const client = await pool.connect();
  const done = {};
  try {
    await client.query('SET statement_timeout = 0');
    await client.query("SELECT pg_advisory_lock(hashtextextended('folk:schema_migrations', 0))");
    await client.query('BEGIN');
    const { rows: legacy } = await client.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE 'legacy\\_%' AND relnamespace = current_schema()::regnamespace");
    const legacyNames = legacy.map((r) => r.relname.slice(7));
    if (!legacyNames.length) throw new Error('No legacy_* tables found: nothing to roll back to.');
    const generic = legacyNames.filter((c) => !typedCollections().includes(c));
    for (const c of legacyNames) {
      const typed = typedCollections().includes(c);
      done[c] = await refreshLegacy(client, c, typed);
    }
    for (const c of legacyNames.filter((n) => typedCollections().includes(n))) {
      await renameObjects(client, c, `typed_backup_${c}`, '', 'typed_backup_');
    }
    for (const c of legacyNames) await renameObjects(client, `legacy_${c}`, c, 'legacy_', '');
    for (const t of [GENERIC_TABLE, 'migration_rejects']) {
      if (await exists(client, t)) await renameObjects(client, t, `typed_backup_${t}`, '', 'typed_backup_');
    }
    await client.query('DELETE FROM schema_migrations');
    await client.query('COMMIT');
    log.info(`[rollback] restored generic tables for ${legacyNames.length} collections (${generic.length} outside the registry); typed tables kept as typed_backup_*`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('folk:schema_migrations', 0))").catch(() => {});
    client.release();
  }
  return { collections: done };
};

module.exports = { rollbackToGeneric };
