'use strict';

/**
 * Bulk import of whole documents with their version / created / updated
 * stamps: used by the legacy-table migration and the Firestore copy.
 *
 * Never fails the batch because of one dirty document:
 *   - a value that does not fit its column lands in `extra` (counted in `diverted`),
 *   - a natural-key UNIQUE clash (duplicate qrToken, two rows for one
 *     event+user) keeps the document but moves the clashing key(s) into `extra`
 *     (counted in `demoted`),
 *   - anything else (orphan FK, unstorable bytes) goes to migration_rejects
 *     with the original JSON (counted in `rejected`).
 * `client` must be inside a transaction (savepoints are used).
 */
const { getAdapter } = require('./codec');
const { buildInsert } = require('./writes');

const CHUNK = 200;

const newReport = () => ({ read: 0, inserted: 0, skipped: 0, demoted: {}, rejected: 0, diverted: {} });

const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

/** Move the given columns' values into extra (unique-clash fallback). */
const demote = (adapter, enc, doc, colNames) => {
  const { schema } = adapter;
  const values = [...enc.values];
  const extra = JSON.parse(values[values.length - 1]);
  for (const name of colNames) {
    const col = schema.byName.get(name);
    if (!col) continue;
    const i = adapter.valueIndex(col);
    if (i >= 0 && values[i] !== null) { extra[col.key] = doc[col.key]; values[i] = null; }
  }
  values[values.length - 1] = JSON.stringify(extra);
  return { values, diverted: enc.diverted };
};

const stamp = (d) => ({
  version: d.version ?? 1,
  createdAt: d.createdAt || new Date().toISOString(),
  updatedAt: d.updatedAt || d.createdAt || new Date().toISOString(),
});

const ONCONFLICT = { skip: 'nothing', overwrite: 'replace', guard0: 'replaceIfV0' };

const insertRows = async (client, adapter, rows, mode) => {
  const stmt = buildInsert(adapter, rows, { onConflict: ONCONFLICT[mode], lock: false, withMeta: true, returning: true });
  return (await client.query(stmt.text, stmt.params)).rowCount;
};

const tryRow = async (client, adapter, row, mode) => {
  await client.query('SAVEPOINT imp_row');
  try {
    const n = await insertRows(client, adapter, [row], mode);
    await client.query('RELEASE SAVEPOINT imp_row');
    return { n };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT imp_row');
    await client.query('RELEASE SAVEPOINT imp_row');
    return { error: e };
  }
};

const reject = async (client, report, migration, collection, doc, error) => {
  report.rejected += 1;
  await client.query(
    'INSERT INTO migration_rejects (migration, collection, doc_id, data, error) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [migration || null, collection, doc.id, JSON.stringify(doc.data === undefined ? null : doc.data), String(error.message || error).slice(0, 500)]);
};

/**
 * docs: [{ id, data, version?, createdAt?, updatedAt? }]; mode: skip | overwrite | guard0.
 * Mutates and returns `report`.
 */
const importDocs = async (client, collection, docs, { mode = 'skip', report = newReport(), migration } = {}) => {
  const adapter = getAdapter(collection);
  for (let i = 0; i < docs.length; i += CHUNK) {
    const slice = docs.slice(i, i + CHUNK);
    const prepared = [];
    for (const d of slice) {
      report.read += 1;
      if (d.data === null || typeof d.data !== 'object' || Array.isArray(d.data)) {
        await reject(client, report, migration, collection, d, new Error('document data is not an object'));
        continue;
      }
      const enc = adapter.encode(d.data);
      enc.diverted.forEach((k) => bump(report.diverted, `${collection}.${k}`));
      prepared.push({ doc: d, enc, row: { id: d.id, values: enc.values, meta: stamp(d) } });
    }
    if (!prepared.length) continue;

    await client.query('SAVEPOINT imp_chunk');
    try {
      const n = await insertRows(client, adapter, prepared.map((p) => p.row), mode);
      await client.query('RELEASE SAVEPOINT imp_chunk');
      report.inserted += n;
      if (mode === 'skip') report.skipped += prepared.length - n;
      continue;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT imp_chunk');
      await client.query('RELEASE SAVEPOINT imp_chunk');
    }

    // Something in the chunk did not fit: place the documents one by one.
    for (const p of prepared) {
      let r = await tryRow(client, adapter, p.row, mode);
      let enc = p.enc;
      for (let attempt = 0; attempt < 3 && r.error && r.error.code === '23505' && adapter.typed
        && adapter.schema.constraintColumns.has(r.error.constraint); attempt += 1) {
        const cols = adapter.schema.constraintColumns.get(r.error.constraint);
        enc = demote(adapter, enc, p.doc.data, cols);
        r = await tryRow(client, adapter, { ...p.row, values: enc.values }, mode);
        bump(report.demoted, `${collection}.${cols.join('+')}`);
      }
      if (r.error) await reject(client, report, migration, collection, p.doc, r.error);
      else { report.inserted += r.n; if (mode === 'skip' && r.n === 0) report.skipped += 1; }
    }
  }
  return report;
};

module.exports = { importDocs, newReport };
