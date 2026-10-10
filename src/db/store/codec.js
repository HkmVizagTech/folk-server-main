'use strict';

/**
 * Document <-> row mapping.
 *
 * A typed table keeps each known document field in its own column and
 * everything else in `extra jsonb`:
 *   - keys with no column,
 *   - explicit nulls (`{"token": null}` must come back as null, not vanish),
 *   - values that do not fit their column (`seats: "2"`, an enum value nobody
 *     planned, a date that is not a date) - never rejected, never coerced.
 * Reading merges columns and extra back into the exact document that was
 * written (same keys, same values). Collections outside the registry use the
 * generic adapter: the whole document in one jsonb column.
 */
const { ISO_RE } = require('./timestamps');
const { getSchema, GENERIC_TABLE } = require('../schema');

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const NUMERIC_LIMIT = 1e10; // numeric(12,2)

const validDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '0001-01-01';
};
const validTs = (s) => {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s && s >= '0001-01-01';
};
const hasNul = (s) => typeof s === 'string' && s.includes('\u0000');
const deepNul = (v) => {
  if (typeof v === 'string') return hasNul(v);
  if (Array.isArray(v)) return v.some(deepNul);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => hasNul(k) || deepNul(x));
  return false;
};

const inRange = (col, v, lo, hi, loose) => (
  v >= Math.max(lo, loose ? -Infinity : (col.min ?? -Infinity)) && v <= Math.min(hi, loose ? Infinity : (col.max ?? Infinity))
);

/**
 * Can `v` be stored in `col` and read back identical? Returns {ok, value} where
 * `value` is what to bind as the query parameter.
 */
const coerce = (col, v, { loose = false } = {}) => {
  const no = { ok: false };
  const yes = (value) => ({ ok: true, value });
  if (v === null || v === undefined) return no;
  switch (col.type) {
    case 'text':
      if (typeof v !== 'string' || hasNul(v)) return no;
      if (!loose && col.enum && !col.enum.includes(v)) return no;
      return yes(v);
    case 'int':
      return Number.isInteger(v) && inRange(col, v, INT_MIN, INT_MAX, loose) ? yes(v) : no;
    case 'bigint':
      return Number.isSafeInteger(v) && inRange(col, v, -Infinity, Infinity, loose) ? yes(v) : no;
    case 'numeric':
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= NUMERIC_LIMIT) return no;
      if (Number(v.toFixed(2)) !== v || !inRange(col, v, -Infinity, Infinity, loose)) return no;
      return yes(v);
    case 'bool':
      return typeof v === 'boolean' ? yes(v) : no;
    case 'ts':
      return validTs(v) ? yes(v) : no;
    case 'date':
      return validDate(v) ? yes(v) : no;
    case 'textArray':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' && !hasNul(x)) ? yes(v) : no;
    case 'jsonb':
      return deepNul(v) ? no : yes(JSON.stringify(v));
    default:
      return no;
  }
};

// SQL cast used when binding a parameter for each column type.
const CASTS = {
  text: 'text', int: 'integer', bigint: 'bigint', numeric: 'numeric', bool: 'boolean',
  ts: 'timestamptz', date: 'date', textArray: 'text[]', jsonb: 'jsonb',
};

// Value read from SQL -> document value.
const fromSql = (col, v) => {
  if (col.type === 'ts') return v instanceof Date ? v.toISOString() : String(v);
  return v;
};

const q = (n) => `"${n}"`;

// ----------------------------------------------------------- typed adapter
const typedAdapter = (schema) => {
  const cols = schema.columns.filter((c) => !c.derived); // columns the store writes
  const writeColumns = [
    { name: 'id', cast: 'text' },
    ...cols.map((c) => ({ name: c.name, cast: CASTS[c.type] })),
    { name: 'extra', cast: 'jsonb' },
  ];
  return {
    typed: true,
    schema,
    /** Position of a written column in encode()'s values (-1 for derived columns). */
    valueIndex: (col) => cols.indexOf(col),
    collection: schema.collection,
    table: q(schema.table),
    idCol: 'id',
    idExpr: '"id"',
    selectList: schema.selectList,
    writeColumns,
    conflictTarget: '("id")',
    refPath: (id) => `${schema.collection}/${id}`,
    /** Fixed (non-document) values of the id columns for an insert: [id]. */
    keyValues: (id) => [id],
    keyColumns: 1,
    /** doc -> { values (aligned with writeColumns after the key), diverted: [keys] } */
    encode(doc) {
      const values = new Array(cols.length).fill(null);
      const extra = [];
      const diverted = [];
      for (const [k, v] of Object.entries(doc)) {
        const col = schema.byKey.get(k);
        if (col && col.derived) continue; // maintained by the database; a written value is ignored
        if (!col) { extra.push([k, v]); continue; }
        if (v === null) { extra.push([k, null]); continue; }
        const c = coerce(col, v);
        if (c.ok) values[cols.indexOf(col)] = c.value;
        else { extra.push([k, v]); diverted.push(k); }
      }
      values.push(JSON.stringify(Object.fromEntries(extra)));
      return { values, diverted };
    },
    decode(row) {
      const extra = row.extra || {};
      const out = [];
      for (const c of schema.columns) {
        const v = row[c.name];
        if (v !== null && v !== undefined) out.push([c.key, fromSql(c, v)]);
        else if (Object.prototype.hasOwnProperty.call(extra, c.key)) out.push([c.key, extra[c.key]]);
      }
      for (const [k, v] of Object.entries(extra)) {
        const c = schema.byKey.get(k);
        if (!c) out.push([k, v]);
      }
      return Object.fromEntries(out);
    },
    meta: (row) => ({ version: row.version, created_at: row.created_at, updated_at: row.updated_at }),
  };
};

// ---------------------------------------------------------- generic adapter
// docs_other(path PK, collection, doc_id, data jsonb, version, created_at, updated_at)
const genericAdapter = (collection) => ({
  typed: false,
  schema: null,
  collection,
  table: q(GENERIC_TABLE),
  idCol: 'path',
  idExpr: '"doc_id"',
  selectList: '"doc_id" AS "id", "data", "version", "created_at", "updated_at"',
  writeColumns: [
    { name: 'path', cast: 'text' }, { name: 'collection', cast: 'text' },
    { name: 'doc_id', cast: 'text' }, { name: 'data', cast: 'jsonb' },
  ],
  conflictTarget: '("path")',
  refPath: (id) => `${collection}/${id}`,
  keyValues: (id) => [`${collection}/${id}`, collection, id],
  keyColumns: 3,
  encode(doc) { return { values: [JSON.stringify(doc)], diverted: [] }; },
  decode(row) { return row.data; },
  meta: (row) => ({ version: row.version, created_at: row.created_at, updated_at: row.updated_at }),
});

const cache = new Map();
/** Adapter for a collection: typed when it is in the registry, generic otherwise. */
const getAdapter = (collection) => {
  let a = cache.get(collection);
  if (!a) {
    const schema = getSchema(collection);
    a = schema ? typedAdapter(schema) : genericAdapter(collection);
    cache.set(collection, a);
  }
  return a;
};

module.exports = { coerce, getAdapter, CASTS, validDate, validTs };
