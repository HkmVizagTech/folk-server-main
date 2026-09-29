/**
 * Postgres document store with the Firestore Admin SDK's API.
 *
 * Every collection is a table:
 *   id text PRIMARY KEY, data jsonb, version bigint, created_at, updated_at
 * so the handlers keep calling db.collection('x').doc(id).get(), .where(),
 * runTransaction(), batch() and FieldValue.* exactly as before, and staff can
 * still query everything in SQL (data->>'status', data->>'userId', ...).
 *
 * Timestamps are stored as ISO strings (2026-01-02T03:04:05.678Z) and come
 * back as Ts objects: strings that also have toDate()/toMillis()/seconds,
 * so code written for Firestore Timestamps keeps working.
 */
const { Pool } = require('pg');
const crypto = require('crypto');

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- timestamps
class Ts extends String {
  static fromDate(d) { return new Ts(new Date(d).toISOString()); }
  static fromMillis(ms) { return new Ts(new Date(ms).toISOString()); }
  static now() { return new Ts(new Date().toISOString()); }
  toDate() { return new Date(this.toString()); }
  toMillis() { return this.toDate().getTime(); }
  get seconds() { return Math.floor(this.toMillis() / 1000); }
  get nanoseconds() { return (this.toMillis() % 1000) * 1e6; }
  isEqual(other) { return other != null && String(other) === this.toString(); }
  toJSON() { return this.toString(); }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// Revive stored JSON: ISO timestamp strings become Ts.
const revive = (v) => {
  if (typeof v === 'string') return ISO_RE.test(v) ? new Ts(v) : v;
  if (Array.isArray(v)) return v.map(revive);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = revive(x);
    return out;
  }
  return v;
};

// ------------------------------------------------------- write-value encoding
// Sentinels are normalised to { __op } objects, both for firebase-admin's
// FieldValue classes (server code) and for the wire format the browser sends.
const OP = '__op';
const sentinel = (v) => {
  if (v === null || typeof v !== 'object') return null;
  if (typeof v[OP] === 'string') return v;
  switch (v.constructor && v.constructor.name) {
    case 'ServerTimestampTransform': return { [OP]: 'serverTimestamp' };
    case 'DeleteTransform': return { [OP]: 'delete' };
    case 'NumericIncrementTransform': return { [OP]: 'increment', n: v.operand };
    case 'ArrayUnionTransform': return { [OP]: 'arrayUnion', v: v.elements };
    case 'ArrayRemoveTransform': return { [OP]: 'arrayRemove', v: v.elements };
    default: return null;
  }
};

// Plain JSON value for storage (no sentinels allowed here).
const toJson = (v) => {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Ts || v instanceof String) return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v.toDate === 'function' && ('seconds' in v || '_seconds' in v)) return v.toDate().toISOString();
  if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return { latitude: v.latitude, longitude: v.longitude };
  if (v.constructor && v.constructor.name === 'DocumentReference' && v.path) return v.path;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJson(x)));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const j = toJson(x);
      if (j !== undefined) out[k] = j;
    }
    return out;
  }
  return null;
};

const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Resolve one written value against the current value at that spot.
// Returns undefined for "delete this field".
const resolveValue = (v, current, nowIso) => {
  const s = sentinel(v);
  if (s) {
    switch (s[OP]) {
      case 'serverTimestamp': return nowIso;
      case 'delete': return undefined;
      case 'increment': {
        const base = typeof current === 'number' ? current : 0;
        return base + Number(s.n || 0);
      }
      case 'arrayUnion': {
        const arr = Array.isArray(current) ? [...current] : [];
        for (const e of (s.v || []).map(toJson)) if (!arr.some((x) => jsonEqual(x, e))) arr.push(e);
        return arr;
      }
      case 'arrayRemove': {
        const rm = (s.v || []).map(toJson);
        return (Array.isArray(current) ? current : []).filter((x) => !rm.some((e) => jsonEqual(x, e)));
      }
      default: throw new StoreError('invalid-argument', `Unknown field operation ${s[OP]}`);
    }
  }
  if (isPlainObject(v)) {
    // A map written in full: resolve sentinels inside it (no merging).
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolveValue(x, undefined, nowIso);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return toJson(v);
};

// set(..., { merge: true }): nested maps merge deeply.
const mergeInto = (target, patch, nowIso) => {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && !sentinel(v)) {
      out[k] = mergeInto(out[k], v, nowIso);
    } else {
      const r = resolveValue(v, out[k], nowIso);
      if (r === undefined) delete out[k]; else out[k] = r;
    }
  }
  return out;
};

const splitPath = (field) => {
  if (typeof field !== 'string') {
    if (field && Array.isArray(field._segments)) return field._segments;
    if (field && Array.isArray(field.segments)) return field.segments;
    throw new StoreError('invalid-argument', 'Field paths must be strings');
  }
  return field.split('.');
};

// update({ 'a.b': 1, c: 2 }): dotted keys address nested fields.
const applyUpdate = (current, patch, nowIso) => {
  const out = JSON.parse(JSON.stringify(current || {}));
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const path = splitPath(key);
    let node = out;
    for (let i = 0; i < path.length - 1; i += 1) {
      if (!isPlainObject(node[path[i]])) node[path[i]] = {};
      node = node[path[i]];
    }
    const last = path[path.length - 1];
    const r = resolveValue(v, node[last], nowIso);
    if (r === undefined) delete node[last]; else node[last] = r;
  }
  return out;
};

const getPath = (obj, path) => path.reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), obj);

const autoId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let id = '';
  for (let i = 0; i < 20; i += 1) id += chars[bytes[i] % chars.length];
  return id;
};

const quoteIdent = (name) => {
  if (!NAME_RE.test(name)) throw new StoreError('invalid-argument', `Bad collection name: ${name}`);
  return `"${name}"`;
};

// ------------------------------------------------------------------ snapshots
class DocumentSnapshot {
  constructor(ref, row) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = !!row;
    this._data = row ? row.data : undefined;
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

// ---------------------------------------------------------------- query → SQL
const RANGE = { '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const jsonType = (v) => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' ? 'string' : Array.isArray(v) ? 'array' : v === null ? 'null' : 'object');

const buildWhere = (filters, params) => {
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const clauses = [];
  for (const { field, op, value } of filters) {
    if (field === '__name__') {
      const idOf = (v) => (v && typeof v === 'object' && v.id ? v.id : String(v));
      if (op === '==') clauses.push(`id = ${p(idOf(value))}`);
      else if (op === '!=') clauses.push(`id <> ${p(idOf(value))}`);
      else if (op === 'in') clauses.push(`id = ANY(${p((value || []).map(idOf))}::text[])`);
      else if (op === 'not-in') clauses.push(`NOT (id = ANY(${p((value || []).map(idOf))}::text[]))`);
      else if (RANGE[op]) clauses.push(`id COLLATE "C" ${RANGE[op]} ${p(idOf(value))}`);
      else throw new StoreError('invalid-argument', `Unsupported operator ${op} on document id`);
      continue;
    }
    const path = splitPath(field);
    const col = `(data #> ${p(path)}::text[])`;
    const v = toJson(value);
    switch (op) {
      case '==':
        clauses.push(`${col} = ${p(JSON.stringify(v))}::jsonb`);
        break;
      case '!=':
        clauses.push(`${col} IS NOT NULL AND ${col} <> 'null'::jsonb AND ${col} <> ${p(JSON.stringify(v))}::jsonb`);
        break;
      case '<': case '<=': case '>': case '>=':
        clauses.push(`jsonb_typeof(${col}) = ${p(jsonType(v))} AND ${col} ${RANGE[op]} ${p(JSON.stringify(v))}::jsonb`);
        break;
      case 'in':
        clauses.push(`${col} = ANY(${p((v || []).map((x) => JSON.stringify(x)))}::jsonb[])`);
        break;
      case 'not-in':
        clauses.push(`${col} IS NOT NULL AND ${col} <> 'null'::jsonb AND NOT (${col} = ANY(${p((v || []).map((x) => JSON.stringify(x)))}::jsonb[]))`);
        break;
      case 'array-contains':
        clauses.push(`jsonb_typeof(${col}) = 'array' AND ${col} @> jsonb_build_array(${p(JSON.stringify(v))}::jsonb)`);
        break;
      case 'array-contains-any':
        clauses.push(`jsonb_typeof(${col}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${col}) e WHERE e = ANY(${p((v || []).map((x) => JSON.stringify(x)))}::jsonb[]))`);
        break;
      default:
        throw new StoreError('invalid-argument', `Unsupported query operator ${op}`);
    }
  }
  return clauses;
};

// Same semantics in JS, used by the browser API's read checks and tests.
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
  _sql(countOnly = false) {
    const params = [];
    const clauses = buildWhere(this._spec.filters, params);
    const order = [];
    for (const o of this._spec.orders) {
      if (o.field === '__name__') { order.push(`id COLLATE "C" ${o.dir}`); continue; }
      params.push(splitPath(o.field));
      const col = `(data #> $${params.length}::text[])`;
      // Firestore leaves out documents that don't have an orderBy field.
      clauses.push(`${col} IS NOT NULL`);
      order.push(`${col} ${o.dir}`);
    }
    order.push(`id COLLATE "C" ${this._spec.orders.length && this._spec.orders[0].dir === 'DESC' ? 'DESC' : 'ASC'}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    if (countOnly) return { text: `SELECT count(*)::int AS n FROM ${quoteIdent(this._name)} ${where}`, params };
    let text = `SELECT id, data, version, created_at, updated_at FROM ${quoteIdent(this._name)} ${where} ORDER BY ${order.join(', ')}`;
    if (this._spec.limit != null) text += ` LIMIT ${this._spec.limit}`;
    if (this._spec.offset != null) text += ` OFFSET ${this._spec.offset}`;
    return { text, params };
  }
  async _run(client) {
    await this._store._ensure(this._name, client);
    const { text, params } = this._sql();
    const { rows } = await (client || this._store.pool).query(text, params);
    const coll = this._store.collection(this._name);
    return new QuerySnapshot(rows.map((r) => new DocumentSnapshot(coll.doc(r.id), r)));
  }
  get() { return this._run(null); }
  count() {
    return {
      get: async () => {
        await this._store._ensure(this._name);
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
    await this._store._ensure(this._name);
    const { rows } = await this._store.pool.query(
      `SELECT id, data, version, created_at, updated_at FROM ${quoteIdent(this._name)} WHERE id = $1`, [this.id]);
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

// -------------------------------------------------------------- transactions
class Transaction {
  constructor(store, client) {
    this._store = store;
    this._client = client;
    this._writes = [];
  }
  async get(refOrQuery) {
    if (refOrQuery instanceof Query) return refOrQuery._run(this._client);
    const ref = refOrQuery;
    await this._store._ensure(ref._name, this._client);
    await this._store._lock(this._client, ref);
    const { rows } = await this._client.query(
      `SELECT id, data, version, created_at, updated_at FROM ${quoteIdent(ref._name)} WHERE id = $1`, [ref.id]);
    return new DocumentSnapshot(ref, rows[0]);
  }
  async getAll(...refs) { return Promise.all(refs.map((r) => this.get(r))); }
  set(ref, data, options) { this._writes.push({ type: 'set', ref, data, merge: !!(options && options.merge) }); return this; }
  update(ref, data) { this._writes.push({ type: 'update', ref, data }); return this; }
  create(ref, data) { this._writes.push({ type: 'create', ref, data }); return this; }
  delete(ref) { this._writes.push({ type: 'delete', ref }); return this; }
}

class WriteBatch {
  constructor(store) {
    this._store = store;
    this._writes = [];
  }
  set(ref, data, options) { this._writes.push({ type: 'set', ref, data, merge: !!(options && options.merge) }); return this; }
  update(ref, data) { this._writes.push({ type: 'update', ref, data }); return this; }
  create(ref, data) { this._writes.push({ type: 'create', ref, data }); return this; }
  delete(ref) { this._writes.push({ type: 'delete', ref }); return this; }
  async commit() {
    const writes = this._writes;
    this._writes = [];
    if (!writes.length) return [];
    await this._store.runTransaction(async (tx) => { tx._writes.push(...writes); });
    return writes.map(() => ({}));
  }
}

const RETRYABLE = new Set(['40001', '40P01']);

class PgStore {
  constructor(connectionString, options = {}) {
    const ssl = options.ssl !== undefined ? options.ssl
      : /sslmode=require|\.proxy\.rlwy\.net|neon\.tech|supabase/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString, ssl, max: options.max || 10 });
    this.pool.on('error', (e) => console.error('[pg] idle client error', e.message));
    this._tables = new Set();
    this._creating = new Map();
    // Called with { collection, id, before, after } after each committed write.
    this.onWrite = null;
  }

  collection(name) {
    if (!NAME_RE.test(name)) throw new StoreError('invalid-argument', `Bad collection name: ${name}`);
    return new CollectionReference(this, name);
  }
  doc(path) {
    const [name, id, ...rest] = String(path).split('/');
    if (!id || rest.length) throw new StoreError('invalid-argument', `Bad document path: ${path}`);
    return this.collection(name).doc(id);
  }
  batch() { return new WriteBatch(this); }

  async runTransaction(fn, { maxAttempts = 5 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const client = await this.pool.connect();
      const tx = new Transaction(this, client);
      const committed = [];
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        for (const w of tx._writes) committed.push(await this._applyWrite(client, w));
        await client.query('COMMIT');
        committed.forEach((c) => this._emit(c));
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        lastError = e;
        if (!RETRYABLE.has(e.code) || attempt === maxAttempts) throw e;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  async listCollections() {
    const { rows } = await this.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`);
    return rows.map((r) => this.collection(r.table_name));
  }

  async close() { await this.pool.end(); }

  // ------------------------------------------------------------ internals
  async _ensure(name) {
    if (this._tables.has(name)) return;
    if (!this._creating.has(name)) {
      const t = quoteIdent(name);
      const sql = `
        CREATE TABLE IF NOT EXISTS ${t} (
          id text PRIMARY KEY,
          data jsonb NOT NULL DEFAULT '{}'::jsonb,
          version bigint NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "${name}_data_gin" ON ${t} USING gin (data jsonb_path_ops);
        CREATE INDEX IF NOT EXISTS "${name}_user_id" ON ${t} ((data->>'userId'));`;
      // Created on its own connection so a later ROLLBACK can't undo it.
      const p = this.pool.query(sql)
        .catch((e) => { if (e.code !== '23505' && e.code !== '42P07') throw e; })
        .then(() => { this._tables.add(name); })
        .finally(() => { this._creating.delete(name); });
      this._creating.set(name, p);
    }
    await this._creating.get(name);
  }

  async _lock(client, ref) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ref.path]);
  }

  async _single(write) {
    let committed;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      committed = await this._applyWrite(client, write);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    this._emit(committed);
    return { writeTime: Ts.now() };
  }

  _emit(c) {
    if (c && typeof this.onWrite === 'function') {
      try { this.onWrite(c); } catch (e) { console.error('[pg] onWrite hook failed', e.message); }
    }
  }

  /**
   * Apply one write inside an open transaction. Returns {collection,id,before,after}.
   */
  async _applyWrite(client, w) {
    const { ref } = w;
    await this._ensure(ref._name);
    await this._lock(client, ref);
    const t = quoteIdent(ref._name);
    const { rows } = await client.query(`SELECT data, version FROM ${t} WHERE id = $1`, [ref.id]);
    const before = rows[0] ? rows[0].data : null;
    const nowIso = new Date().toISOString();
    if (w.expectVersion !== undefined) {
      const have = rows[0] ? Number(rows[0].version) : 0;
      if (have !== w.expectVersion) throw new StoreError('aborted', 'The document changed; retry the transaction.');
    }
    let after;
    switch (w.type) {
      case 'delete':
        await client.query(`DELETE FROM ${t} WHERE id = $1`, [ref.id]);
        return { collection: ref._name, id: ref.id, before, after: null };
      case 'create':
        if (before) throw new StoreError('already-exists', `Document already exists: ${ref.path}`);
        after = mergeInto({}, w.data || {}, nowIso);
        break;
      case 'set':
        after = w.merge ? mergeInto(before || {}, w.data || {}, nowIso) : mergeInto({}, w.data || {}, nowIso);
        break;
      case 'update':
        if (!before) throw new StoreError('not-found', `No document to update: ${ref.path}`);
        after = applyUpdate(before, w.data || {}, nowIso);
        break;
      default:
        throw new StoreError('invalid-argument', `Unknown write ${w.type}`);
    }
    await client.query(
      `INSERT INTO ${t} (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = ${t}.version + 1, updated_at = now()`,
      [ref.id, JSON.stringify(after)]);
    return { collection: ref._name, id: ref.id, before, after };
  }
}

module.exports = {
  PgStore,
  Ts,
  StoreError,
  revive,
  toJson,
  mergeInto,
  applyUpdate,
  matchesFilter,
  getPath,
  splitPath,
  autoId,
  NAME_RE,
  OP,
};
