'use strict';

/**
 * CREATE TABLE / INDEX statements for the typed schemas. Used to generate
 * migration 001 (scripts/gen-schema-sql.js) and by tests; the migration file
 * itself is the source of truth once committed.
 */
const { listSchemas } = require('./index');

const q = (n) => `"${n.replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const idxCol = (c) => { const m = c.match(/^(\S+)(\s+(?:ASC|DESC))?$/i); return `${q(m[1])}${m[2] || ''}`; };

const checksFor = (s, c) => {
  const out = [];
  if (c.enum) out.push(`${q(c.name)} IN (${c.enum.map(lit).join(', ')})`);
  if (c.min !== undefined) out.push(`${q(c.name)} >= ${c.min}`);
  if (c.max !== undefined) out.push(`${q(c.name)} <= ${c.max}`);
  return out;
};

const tableSql = (s) => {
  const lines = ['  "id" text PRIMARY KEY'];
  for (const c of s.columns) lines.push(`  ${q(c.name)} ${c.sqlType}`);
  lines.push(`  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  lines.push('  "version" bigint NOT NULL DEFAULT 1');
  lines.push('  "created_at" timestamptz NOT NULL DEFAULT now()');
  lines.push('  "updated_at" timestamptz NOT NULL DEFAULT now()');
  for (const c of s.columns) {
    const parts = checksFor(s, c);
    if (parts.length) lines.push(`  CONSTRAINT ${q(`${s.table}_${c.name}_chk`.slice(0, 63))} CHECK (${parts.join(' AND ')})`);
  }
  lines.push(`  CONSTRAINT ${q(`${s.table}_extra_object_chk`)} CHECK (jsonb_typeof("extra") = 'object')`);
  for (const u of s.unique) lines.push(`  CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(', ')})`);
  return `CREATE TABLE ${q(s.table)} (\n${lines.join(',\n')}\n);`;
};

const fkSql = (s) => s.foreignKeys.map((f) => `ALTER TABLE ${q(s.table)} ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${f.references} ON DELETE ${f.onDelete || 'NO ACTION'}${f.deferrable ? ' DEFERRABLE INITIALLY DEFERRED' : ''};`);

const indexSql = (s) => s.indexes.map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(s.table)} (${i.columns.map(idxCol).join(', ')})${i.where ? ` WHERE ${i.where}` : ''};`);

const commentSql = (s) => {
  const out = [`COMMENT ON TABLE ${q(s.table)} IS ${lit(`${s.collection}: ${s.idFormat ? `id = ${s.idFormat}` : ''}`)};`];
  for (const c of s.columns) out.push(`COMMENT ON COLUMN ${q(s.table)}.${q(c.name)} IS ${lit(`document field "${c.key}"`)};`);
  out.push(`COMMENT ON COLUMN ${q(s.table)}."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';`);
  return out;
};

const fullSql = () => {
  const schemas = listSchemas();
  const out = [];
  for (const s of schemas) { out.push(`-- ${s.collection}`); out.push(tableSql(s)); out.push(...indexSql(s)); out.push(...commentSql(s)); out.push(''); }
  for (const s of schemas) out.push(...fkSql(s));
  return out.join('\n');
};

module.exports = { tableSql, indexSql, fkSql, commentSql, fullSql };
