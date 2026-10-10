'use strict';

/**
 * Registry of every typed collection. One file per collection in this folder;
 * each describes the table, its columns (document field -> SQL column), the
 * natural-key UNIQUEs, the indexes (one per query shape) and the few FKs.
 * Collections not listed here live in the generic `docs_other` table.
 */
const crypto = require('crypto');
const { SQL_TYPES, RESERVED } = require('./dsl');

const FILES = [
  'users', 'events', 'event_secrets', 'registrations', 'attendance', 'prasadam_logs',
  'sadhana_logs', 'sevas', 'seva_registrations', 'trips', 'trip_registrations', 'payments',
  'accommodation_requests', 'hostel_listings', 'hostel_bookings', 'courses', 'enrollments',
  'followups', 'notifications', 'contact_messages', 'broadcasts', 'otp_codes', 'system',
];

// Postgres truncates identifiers at 63 bytes; make long generated names unique instead.
const ident = (name) => (name.length <= 63
  ? name
  : `${name.slice(0, 54)}_${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`);

const stripDir = (c) => c.replace(/\s+(ASC|DESC)$/i, '');

const compile = (def) => {
  const columns = def.columns.map((c) => ({ ...c, sqlType: SQL_TYPES[c.type] }));
  const byKey = new Map();
  const byName = new Map();
  for (const c of columns) {
    if (!SQL_TYPES[c.type]) throw new Error(`${def.collection}.${c.key}: unknown type ${c.type}`);
    if (RESERVED.has(c.name)) throw new Error(`${def.collection}.${c.key}: column name ${c.name} is reserved`);
    if (byKey.has(c.key)) throw new Error(`${def.collection}: duplicate key ${c.key}`);
    if (byName.has(c.name)) throw new Error(`${def.collection}: duplicate column ${c.name}`);
    byKey.set(c.key, c);
    byName.set(c.name, c);
  }
  const need = (cols, what) => {
    for (const raw of cols) {
      const n = stripDir(raw);
      if (n !== 'id' && !byName.has(n)) throw new Error(`${def.collection}: ${what} refers to unknown column ${n}`);
    }
  };
  const unique = (def.unique || []).map((u) => {
    need(u.columns, 'unique');
    return { ...u, name: u.name || ident(`${def.table}_${u.columns.join('_')}_key`) };
  });
  const indexes = (def.indexes || []).map((i) => {
    need(i.columns, 'index');
    const base = i.columns.map((c) => c.replace(/\s+DESC$/i, '_desc').replace(/\s+ASC$/i, '')).join('_');
    return { ...i, name: i.name || ident(`${def.table}_${base}${i.where ? '_partial' : ''}_idx`) };
  });
  const foreignKeys = (def.foreignKeys || []).map((f) => ({
    ...f, name: f.name || ident(`${def.table}_${f.columns.join('_')}_fkey`),
  }));
  const sqlCols = ['id', ...columns.map((c) => c.name), 'extra', 'version', 'created_at', 'updated_at'];
  return {
    kind: 'typed',
    ...def,
    columns,
    byKey,
    byName,
    unique,
    indexes,
    foreignKeys,
    selectList: sqlCols.map((n) => `"${n}"`).join(', '),
    constraintColumns: new Map(unique.map((u) => [u.name, u.columns])),
  };
};

const schemas = new Map();
for (const f of FILES) {
  const s = compile(require(`./${f}`));
  if (s.collection !== f) throw new Error(`schema ${f}: collection name mismatch`);
  schemas.set(s.collection, s);
}

// Collections outside the registry: whole document in a jsonb column.
const GENERIC_TABLE = 'docs_other';

/** The compiled schema for a collection, or null when it is a generic (untyped) one. */
const getSchema = (collection) => schemas.get(collection) || null;
const listSchemas = () => [...schemas.values()];
const typedCollections = () => [...schemas.keys()];

module.exports = { getSchema, listSchemas, typedCollections, GENERIC_TABLE, compile, ident };
