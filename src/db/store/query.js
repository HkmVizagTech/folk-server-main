'use strict';

/**
 * References, snapshots and the query builder (Firestore-style where /
 * orderBy / limit compiled to parameterised SQL).
 *
 * Fields resolve to one of:
 *   - a typed column .......... compared natively (indexable). A query value
 *     the column could never hold (wrong type, outside an enum) can only match
 *     rows whose value was kept in `extra`, so it is compared there instead.
 *   - a jsonb / text[] column . compared as JSON
 *   - an `extra` key .......... compared as JSON (extra #> path)
 *   - the generic table's data  compared as JSON
 * Semantics are those of the old generic store: an absent field never matches
 * `==`; `!=` / not-in need the field to exist and be non-null; orderBy(field)
 * drops rows where the field is missing; ties break on the id in "C" order.
 */
const { StoreError } = require('./errors');
const { Ts, revive } = require('./timestamps');
const { toJson, splitPath, getPath, jsonEqual } = require('./field-ops');
const { autoId, checkName } = require('./ids');
const { coerce, getAdapter, CASTS } = require('./codec');

const q = (n) => `"${n}"`;
const RANGE = { '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const jsonType = (v) => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' ? 'string' : Array.isArray(v) ? 'array' : v === null ? 'null' : 'object');
const js = (v) => JSON.stringify(v);

// ------------------------------------------------------------------ snapshots
class DocumentSnapshot {
  constructor(ref, row) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = !!row;
    this._data = row ? getAdapter(ref._name).decode(row) : undefined;
    this.version = row ? Number(row.version) : 0;
    this.createTime = row && row.created_at ? Ts.fromDate(row.created_at) : undefined;
    this.updateTime = row && row.updated_at ? Ts.fromDate(row.updated_at) : undefined;
  }
  data() { return this.exists ? revive(this._data) : undefined; }
  get(field) { return this.exists ? revive(getPath(this._data, splitPath(field))) : undefined; }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
  forEach(fn) { this.docs.forEach(fn); }
}

// ----------------------------------------------------------- JSON comparisons
const jsonClause = (E, op, v, p) => {
  const arr = (x) => (Array.isArray(x) ? x : []);
  switch (op) {
    case '==': return `${E} = ${p(js(v))}::jsonb`;
    case '!=': return `${E} IS NOT NULL AND ${E} <> 'null'::jsonb AND ${E} <> ${p(js(v))}::jsonb`;
    case '<': case '<=': case '>': case '>=':
      return `jsonb_typeof(${E}) = ${p(jsonType(v))} AND ${E} ${RANGE[op]} ${p(js(v))}::jsonb`;
    case 'in': return `${E} = ANY(${p(arr(v).map(js))}::jsonb[])`;
    case 'not-in': return `${E} IS NOT NULL AND ${E} <> 'null'::jsonb AND NOT (${E} = ANY(${p(arr(v).map(js))}::jsonb[]))`;
    case 'array-contains': return `jsonb_typeof(${E}) = 'array' AND ${E} @> jsonb_build_array(${p(js(v))}::jsonb)`;
    case 'array-contains-any':
      return `jsonb_typeof(${E}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${E}) e WHERE e = ANY(${p(arr(v).map(js))}::jsonb[]))`;
    default: throw new StoreError('invalid-argument', `Unsupported query operator ${op}`);
  }
};

// Native comparison on a scalar typed column (text/int/numeric/bool/ts/date).
const scalarClause = (col, Ef, op, v, p) => {
  const c = q(col.name);
  const cast = CASTS[col.type];
  const strict = (x) => coerce(col, x).ok;
  const loose = (x) => coerce(col, x, { loose: true }).ok;
  const val = (x) => coerce(col, x, { loose: true }).value;
  const list = Array.isArray(v) ? v : [];
  switch (op) {
    case '==': return strict(v) ? `${c} = ${p(val(v))}::${cast}` : jsonClause(Ef(), '==', v, p);
    case '!=': {
      const typed = loose(v) ? `${c} IS NOT NULL AND ${c} <> ${p(val(v))}::${cast}` : `${c} IS NOT NULL`;
      return `((${typed}) OR (${jsonClause(Ef(), '!=', v, p)}))`;
    }
    case '<': case '<=': case '>': case '>=':
      return loose(v) ? `${c} ${RANGE[op]} ${p(val(v))}::${cast}` : jsonClause(Ef(), op, v, p);
    case 'in': {
      const typedVals = list.filter(strict).map(val);
      const rest = list.filter((x) => !strict(x));
      const parts = [];
      if (typedVals.length) parts.push(`${c} = ANY(${p(typedVals)}::${cast}[])`);
      if (rest.length) parts.push(`(${jsonClause(Ef(), 'in', rest, p)})`);
      return parts.length ? `(${parts.join(' OR ')})` : 'false';
    }
    case 'not-in': {
      const typedVals = list.filter(strict).map(val);
      const rest = list.filter((x) => !strict(x));
      const typed = typedVals.length ? `${c} IS NOT NULL AND NOT (${c} = ANY(${p(typedVals)}::${cast}[]))` : `${c} IS NOT NULL`;
      return `((${typed}) OR (${jsonClause(Ef(), 'not-in', rest, p)}))`;
    }
    default: return jsonClause(Ef(), op, v, p); // array ops: only ever match a value kept in extra
  }
};

/** Resolve a field path to { col?, E } where E is a JSON-valued SQL expression. */
const resolveField = (adapter, field, p) => {
  const path = splitPath(field);
  if (!adapter.typed) return { E: `("data" #> ${p(path)}::text[])` };
  const col = adapter.schema.byKey.get(path[0]);
  let cached;
  const Ef = () => { if (cached === undefined) cached = `("extra" #> ${p(path)}::text[])`; return cached; };
  if (!col) return { E: Ef() };
  if (path.length === 1) {
    if (col.type === 'jsonb') return { E: `COALESCE(${q(col.name)}, ${Ef()})` };
    if (col.type === 'textArray') return { E: `COALESCE(to_jsonb(${q(col.name)}), ${Ef()})` };
    return { col, Ef, order: q(col.name) };
  }
  if (col.type === 'jsonb') return { E: `${q(col.name)} #> ${p(path.slice(1))}::text[]` };
  return { E: Ef() };
};

const buildWhere = (adapter, filters, params) => {
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const clauses = [];
  if (!adapter.typed) clauses.push(`"collection" = ${p(adapter.collection)}`);
  for (const { field, op, value } of filters) {
    if (field === '__name__') {
      const idOf = (v) => (v && typeof v === 'object' && v.id ? v.id : String(v));
      const id = adapter.idExpr;
      if (op === '==') clauses.push(`${id} = ${p(idOf(value))}`);
      else if (op === '!=') clauses.push(`${id} <> ${p(idOf(value))}`);
      else if (op === 'in') clauses.push(`${id} = ANY(${p((value || []).map(idOf))}::text[])`);
      else if (op === 'not-in') clauses.push(`NOT (${id} = ANY(${p((value || []).map(idOf))}::text[]))`);
      else if (RANGE[op]) clauses.push(`${id} COLLATE "C" ${RANGE[op]} ${p(idOf(value))}`);
      else throw new StoreError('invalid-argument', `Unsupported operator ${op} on document id`);
      continue;
    }
    const f = resolveField(adapter, field, p);
    const v = toJson(value);
    clauses.push(f.col ? scalarClause(f.col, f.Ef, op, v, p) : jsonClause(f.E, op, v, p));
  }
  return clauses;
};

const buildQuery = (adapter, spec, countOnly = false) => {
  const params = [];
  const clauses = buildWhere(adapter, spec.filters, params);
  const order = [];
  for (const o of spec.orders) {
    if (o.field === '__name__') { order.push(`${adapter.idExpr} COLLATE "C" ${o.dir}`); continue; }
    const f = resolveField(adapter, o.field, (v) => { params.push(v); return `$${params.length}`; });
    const expr = f.order || f.E;
    // Firestore leaves out documents that don't have an orderBy field.
    clauses.push(`${expr} IS NOT NULL`);
    order.push(`${expr} ${o.dir}`);
  }
  order.push(`${adapter.idExpr} COLLATE "C" ${spec.orders.length && spec.orders[0].dir === 'DESC' ? 'DESC' : 'ASC'}`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  if (countOnly) return { text: `SELECT count(*)::int AS n FROM ${adapter.table} ${where}`, params };
  let text = `SELECT ${adapter.selectList} FROM ${adapter.table} ${where} ORDER BY ${order.join(', ')}`;
  if (spec.limit != null) text += ` LIMIT ${spec.limit}`;
  if (spec.offset != null) text += ` OFFSET ${spec.offset}`;
  return { text, params };
};

// Same semantics in JS, used by tests.
const matchesFilter = (row, { field, op, value }) => {
  const actual = field === '__name__' ? row.id : getPath(row.data, splitPath(field));
  const v = field === '__name__' ? (value && value.id ? value.id : String(value)) : toJson(value);
  switch (op) {
    case '==': return actual !== undefined && jsonEqual(actual, v);
    case '!=': return actual !== undefined && actual !== null && !jsonEqual(actual, v);
    case 'in': return actual !== undefined && (v || []).some((x) => jsonEqual(actual, x));
    case 'array-contains': return Array.isArray(actual) && actual.some((x) => jsonEqual(x, v));
    default: return true;
  }
};

// ------------------------------------------------------------------ queries
class Query {
  constructor(store, name, spec = {}) {
    this._store = store;
    this._name = name;
    this._spec = { filters: [], orders: [], limit: null, offset: null, ...spec };
  }
  _with(patch) { return new Query(this._store, this._name, { ...this._spec, ...patch }); }
  where(field, op, value) {
    if (field && typeof field === 'object' && field._filters) throw new StoreError('invalid-argument', 'Composite filters are not supported');
    const f = field && field._segments ? field._segments.join('.') : field;
    return this._with({ filters: [...this._spec.filters, { field: f, op, value }] });
  }
  orderBy(field, dir = 'asc') {
    return this._with({ orders: [...this._spec.orders, { field, dir: String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC' }] });
  }
  limit(n) { return this._with({ limit: Math.max(0, parseInt(n, 10) || 0) }); }
  offset(n) { return this._with({ offset: Math.max(0, parseInt(n, 10) || 0) }); }
  _sql(countOnly = false) { return buildQuery(getAdapter(this._name), this._spec, countOnly); }
  async _run(client) {
    const { text, params } = this._sql();
    const { rows } = await (client || this._store.pool).query(text, params);
    const coll = this._store.collection(this._name);
    return new QuerySnapshot(rows.map((r) => new DocumentSnapshot(coll.doc(r.id), r)));
  }
  get() { return this._run(null); }
  count() {
    return {
      get: async () => {
        const { text, params } = this._sql(true);
        const { rows } = await this._store.pool.query(text, params);
        return { data: () => ({ count: rows[0].n }) };
      },
    };
  }
}

class CollectionReference extends Query {
  constructor(store, name) {
    super(store, name);
    this.id = name;
    this.path = name;
  }
  doc(id) {
    const docId = id === undefined ? autoId() : String(id);
    if (!docId || docId.includes('/')) throw new StoreError('invalid-argument', `Bad document id: ${id}`);
    return new DocumentReference(this._store, this._name, docId);
  }
  async add(data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

class DocumentReference {
  constructor(store, name, id) {
    this._store = store;
    this._name = name;
    this.id = id;
    this.path = `${name}/${id}`;
  }
  get parent() { return this._store.collection(this._name); }
  collection() { throw new StoreError('unimplemented', 'Subcollections are not supported'); }
  async get() {
    const adapter = getAdapter(this._name);
    const { rows } = await this._store.pool.query(
      `SELECT ${adapter.selectList} FROM ${adapter.table} WHERE ${q(adapter.idCol)} = $1`, [adapter.keyValues(this.id)[0]]);
    return new DocumentSnapshot(this, rows[0]);
  }
  set(data, options) { return this._store._single({ type: 'set', ref: this, data, merge: !!(options && options.merge) }); }
  update(data, ...rest) {
    let patch = data;
    if (typeof data === 'string') { // update('field', value, 'field2', value2, ...)
      const pairs = [data, ...rest];
      patch = {};
      for (let i = 0; i + 1 < pairs.length; i += 2) patch[pairs[i]] = pairs[i + 1];
    }
    return this._store._single({ type: 'update', ref: this, data: patch });
  }
  create(data) { return this._store._single({ type: 'create', ref: this, data }); }
  delete() { return this._store._single({ type: 'delete', ref: this }); }
}

module.exports = {
  DocumentSnapshot, QuerySnapshot, Query, CollectionReference, DocumentReference,
  buildQuery, matchesFilter, checkName,
};
