'use strict';

/**
 * 002: copy the documents of every legacy_<collection> table (renamed by 001)
 * into the typed tables - or into docs_other for collections outside the
 * registry. Legacy tables are READ ONLY here and are never dropped.
 *
 * Dirty documents never fail the migration (see store/importer.js): values
 * that do not fit a column are kept in `extra`, natural-key clashes keep the
 * document but move the clashing key into `extra`, and documents that cannot
 * be placed at all are written to migration_rejects. A per-collection summary
 * (read / inserted / demoted / rejected / diverted) is logged and stored in
 * schema_migrations.details.
 */
const { importDocs, newReport } = require('../store/importer');
const { typedCollections } = require('../schema');

const PAGE = 1000;

const legacyTables = async (client) => {
  const { rows } = await client.query(`
    SELECT cl.relname FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = current_schema() AND cl.relkind = 'r' AND cl.relname LIKE 'legacy\\_%'
      AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = cl.oid AND NOT a.attisdropped
           AND a.attname IN ('id', 'data', 'version', 'created_at', 'updated_at')) = 5`);
  return rows.map((r) => r.relname.slice('legacy_'.length));
};

const up = async (client, { log = console } = {}) => {
  const legacy = new Set(await legacyTables(client));
  // The only FK (event_secrets -> events) is deferrable; check it per
  // statement here so an orphan secret is caught and rejected on its own.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');

  // Registry order puts events before event_secrets; unregistered collections go last.
  const order = [...typedCollections().filter((c) => legacy.has(c)), ...[...legacy].filter((c) => !typedCollections().includes(c)).sort()];
  const summary = {};
  for (const name of order) {
    const report = newReport();
    let last = null;
    for (;;) {
      const { rows } = await client.query(
        `SELECT id, data, version, created_at, updated_at FROM "legacy_${name}"
         WHERE ($1::text IS NULL OR id COLLATE "C" > $1) ORDER BY id COLLATE "C" LIMIT ${PAGE}`, [last]);
      if (!rows.length) break;
      await importDocs(client, name, rows.map((r) => ({
        id: r.id, data: r.data, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
      })), { mode: 'skip', report, migration: '002_import_legacy_documents' });
      last = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
    summary[name] = { ...report, typed: typedCollections().includes(name) };
    const flags = [
      report.rejected ? `${report.rejected} rejected` : '',
      Object.keys(report.demoted).length ? `demoted ${JSON.stringify(report.demoted)}` : '',
      Object.keys(report.diverted).length ? `type anomalies ${JSON.stringify(report.diverted)}` : '',
    ].filter(Boolean).join('; ');
    log.info(`[migrate] ${name}: ${report.read} read, ${report.inserted} inserted${flags ? `; ${flags}` : ''}`);
  }
  const typed = typedCollections().filter((c) => legacy.has(c));
  if (typed.length) await client.query(`ANALYZE ${typed.map((c) => `"${c}"`).join(', ')}`);
  const totals = Object.values(summary).reduce((a, r) => ({
    read: a.read + r.read, inserted: a.inserted + r.inserted, rejected: a.rejected + r.rejected,
    demoted: a.demoted + Object.values(r.demoted).reduce((x, y) => x + y, 0),
    diverted: a.diverted + Object.values(r.diverted).reduce((x, y) => x + y, 0),
  }), { read: 0, inserted: 0, rejected: 0, demoted: 0, diverted: 0 });
  log.info(`[migrate] legacy import: ${JSON.stringify(totals)}${totals.rejected ? ' - see table migration_rejects' : ''}`);
  return { legacyTables: [...legacy].sort(), totals, collections: summary };
};

module.exports = { up };
