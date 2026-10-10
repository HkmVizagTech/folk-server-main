'use strict';

/**
 * Turning writes into SQL.
 *
 * Every write takes the document's advisory lock (so a runTransaction that
 * read the document keeps its "nobody changed it since" guarantee) and then:
 *   - set / create / delete ........ ONE statement (INSERT .. ON CONFLICT, DELETE)
 *   - set{merge} / update, when the patch only touches top-level fields (typed
 *     columns or extra keys, sentinels: serverTimestamp, delete, increment on a
 *     number column) ........................ ONE statement (partial upsert / UPDATE)
 *   - anything else (dotted paths, nested merges, arrayUnion/Remove, increments
 *     that need to be re-checked) ... lock, SELECT .. FOR UPDATE, compute the
 *     new document in JS, write the whole row back.
 * Consecutive set/create writes to one collection in a commit become one
 * multi-row INSERT.
 */
const { StoreError } = require('./errors');
const { isPlainObject } = require('./timestamps');
const { OP, sentinel, toJson, resolveValue, mergeInto, applyUpdate } = require('./field-ops');
const { coerce, getAdapter, CASTS } = require('./codec');

const q = (n) => `"${n}"`;
const LOCK = (idx) => `l AS (SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0))) AS n FROM unnest($${idx}::text[]) AS k)`;

// ------------------------------------------------------------ SQL builders
/**
 * Multi-row INSERT. rows: [{ id, values, meta? }] where values are the encoded
 * (non-key) column values. onConflict: 'update' | 'nothing' | 'replace' | 'replaceIfV0'.
 */
const buildInsert = (adapter, rows, { onConflict = 'update', lock = true, returning = false, withMeta = false } = {}) => {
  const params = [];
  const bind = (v, cast) => { params.push(v); return `$${params.length}::${cast}`; };
  let lockIdx = 0;
  if (lock) { params.push(rows.map((r) => adapter.refPath(r.id)).sort()); lockIdx = 1; }
  const cols = [...adapter.writeColumns];
  const metaCols = withMeta ? [{ name: 'version', cast: 'bigint' }, { name: 'created_at', cast: 'timestamptz' }, { name: 'updated_at', cast: 'timestamptz' }] : [];
  const tuples = rows.map((r) => {
    const vals = [...adapter.keyValues(r.id), ...r.values];
    const parts = vals.map((v, i) => bind(v, cols[i].cast));
    if (withMeta) parts.push(bind(r.meta.version, 'bigint'), bind(r.meta.createdAt, 'timestamptz'), bind(r.meta.updatedAt, 'timestamptz'));
    return `(${parts.join(', ')})`;
  });
  const all = [...cols, ...metaCols];
  const t = adapter.table;
  const setCols = cols.slice(adapter.keyColumns).map((c) => `${q(c.name)} = EXCLUDED.${q(c.name)}`);
  let conflict;
  switch (onConflict) {
    case 'nothing': conflict = `ON CONFLICT ${adapter.conflictTarget} DO NOTHING`; break;
    case 'replace': case 'replaceIfV0':
      conflict = `ON CONFLICT ${adapter.conflictTarget} DO UPDATE SET ${[...setCols, '"version" = EXCLUDED."version"', '"created_at" = EXCLUDED."created_at"', '"updated_at" = EXCLUDED."updated_at"'].join(', ')}${onConflict === 'replaceIfV0' ? ` WHERE ${t}."version" = 0` : ''}`;
      break;
    default:
      conflict = `ON CONFLICT ${adapter.conflictTarget} DO UPDATE SET ${[...setCols, `"version" = ${t}."version" + 1`, '"updated_at" = now()'].join(', ')}`;
  }
  const source = `(VALUES ${tuples.join(', ')}) AS v`;
  const text = `${lock ? `WITH ${LOCK(lockIdx)} ` : ''}INSERT INTO ${t} (${all.map((c) => q(c.name)).join(', ')}) SELECT v.* FROM ${lock ? 'l, ' : ''}${source} WHERE true ${conflict}${returning ? ' RETURNING 1' : ''}`;
  return { text, params };
};

// ------------------------------------------------------------ patch planning
const NUMERIC_TYPES = new Set(['int', 'bigint', 'numeric']);

/**
 * Plan a top-level patch as column assignments + extra edits, or return null
 * when the generic read-modify-write path is needed.
 */
const planPatch = (adapter, patch, mode, nowIso) => {
  if (!adapter.typed) return null;
  const { schema } = adapter;
  const assigns = []; // { col, value } (value null = SQL NULL)
  const incs = []; // { col, n, key }
  const extraAdd = [];
  const extraRem = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (mode === 'update' && key.includes('.')) return null;
    const col = schema.byKey.get(key);
    const s = sentinel(raw);
    let value;
    if (s) {
      switch (s[OP]) {
        case 'serverTimestamp': value = nowIso; break;
        case 'delete':
          if (col) assigns.push({ col, value: null });
          extraRem.push(key);
          continue;
        case 'increment': {
          const n = Number(s.n || 0);
          if (mode !== 'update' || !col || !NUMERIC_TYPES.has(col.type) || !Number.isFinite(n)) return null;
          if (col.type !== 'numeric' && !Number.isInteger(n)) return null;
          if (col.type === 'numeric' && Number(n.toFixed(2)) !== n) return null;
          incs.push({ col, n, key });
          continue;
        }
        default: return null; // arrayUnion / arrayRemove: generic path
      }
    } else if (isPlainObject(raw)) {
      if (mode === 'merge') return null; // nested maps merge deeply
      value = resolveValue(raw, undefined, nowIso);
    } else {
      value = toJson(raw);
    }
    if (value === null || value === undefined) {
      if (col) assigns.push({ col, value: null });
      extraAdd.push([key, null]);
      continue;
    }
    if (col) {
      const c = coerce(col, value);
      if (c.ok) { assigns.push({ col, value: c.value }); extraRem.push(key); } else { assigns.push({ col, value: null }); extraAdd.push([key, value]); }
    } else {
      extraAdd.push([key, value]);
    }
  }
  return { assigns, incs, extraAdd: Object.fromEntries(extraAdd), extraRem };
};

const incExpr = (inc, nParam) => {
  const { col, key } = inc;
  const base = `COALESCE(${q(col.name)}::numeric, CASE WHEN jsonb_typeof("extra" -> '${key.replace(/'/g, "''")}') = 'number' THEN ("extra" ->> '${key.replace(/'/g, "''")}')::numeric END, 0)`;
  const next = `(${base} + ${nParam}::numeric)`;
  let guard;
  if (col.type === 'numeric') {
    guard = `round(${next}, 2) = ${next} AND abs(${next}) < 1e10${col.min !== undefined ? ` AND ${next} >= ${col.min}` : ''}${col.max !== undefined ? ` AND ${next} <= ${col.max}` : ''}`;
  } else {
    const lo = Math.max(col.type === 'int' ? -2147483648 : -9007199254740991, col.min ?? -Infinity);
    const hi = Math.min(col.type === 'int' ? 2147483647 : 9007199254740991, col.max ?? Infinity);
    guard = `trunc(${next}) = ${next} AND ${next} BETWEEN ${lo} AND ${hi}`;
  }
  return { set: `${q(col.name)} = ${next}::${CASTS[col.type]}`, guard };
};

const buildUpdate = (adapter, ref, plan) => {
  const params = [adapter.refPath(ref.id), ref.id];
  const bind = (v, cast) => { params.push(v); return `$${params.length}::${cast}`; };
  const sets = plan.assigns.map(({ col, value }) => `${q(col.name)} = ${bind(value, CASTS[col.type])}`);
  const guards = [];
  for (const inc of plan.incs) {
    const e = incExpr(inc, bind(inc.n, 'numeric'));
    sets.push(e.set);
    guards.push(e.guard);
    plan.extraRem.push(inc.key);
  }
  const hasExtra = plan.extraRem.length || Object.keys(plan.extraAdd).length;
  if (hasExtra) sets.push(`"extra" = ("extra" - ${bind(plan.extraRem, 'text[]')}) || ${bind(JSON.stringify(plan.extraAdd), 'jsonb')}`);
  sets.push('"version" = "version" + 1', '"updated_at" = now()');
  const text = `WITH l AS (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) UPDATE ${adapter.table} SET ${sets.join(', ')} FROM l WHERE ${q(adapter.idCol)} = $2${guards.map((g) => ` AND ${g}`).join('')}`;
  return { text, params };
};

// Partial upsert for set(..., {merge:true}) with top-level fields only.
const buildMergeUpsert = (adapter, ref, plan) => {
  const params = [[adapter.refPath(ref.id)]];
  const bind = (v, cast) => { params.push(v); return `$${params.length}::${cast}`; };
  const names = ['id'];
  const vals = [bind(ref.id, 'text')];
  for (const { col, value } of plan.assigns) { names.push(col.name); vals.push(bind(value, CASTS[col.type])); }
  names.push('extra');
  vals.push(bind(JSON.stringify(plan.extraAdd), 'jsonb'));
  const t = adapter.table;
  const sets = plan.assigns.map(({ col }) => `${q(col.name)} = EXCLUDED.${q(col.name)}`);
  sets.push(`"extra" = (${t}."extra" - ${bind(plan.extraRem, 'text[]')}) || EXCLUDED."extra"`, `"version" = ${t}."version" + 1`, '"updated_at" = now()');
  const text = `WITH ${LOCK(1)} INSERT INTO ${t} (${names.map(q).join(', ')}) SELECT ${vals.join(', ')} FROM l WHERE true ON CONFLICT ("id") DO UPDATE SET ${sets.join(', ')}`;
  return { text, params };
};

// ------------------------------------------------------------ execution
const emitOf = (w) => ({ collection: w.ref._name, id: w.ref.id, type: w.type });

const encodeFull = (adapter, doc) => adapter.encode(doc);

/** Lock + SELECT FOR UPDATE + JS merge + write the whole row. `client` is inside a transaction. */
const applySlow = async (client, w, nowIso) => {
  const adapter = getAdapter(w.ref._name);
  const path = adapter.refPath(w.ref.id);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [path]);
  const { rows } = await client.query(`SELECT ${adapter.selectList} FROM ${adapter.table} WHERE ${q(adapter.idCol)} = $1 FOR UPDATE`, [adapter.typed ? w.ref.id : path]);
  const row = rows[0];
  const before = row ? adapter.decode(row) : null;
  if (w.expectVersion !== undefined) {
    const have = row ? Number(row.version) : 0;
    if (have !== w.expectVersion) throw new StoreError('aborted', 'The document changed; retry the transaction.');
  }
  let after;
  switch (w.type) {
    case 'create':
      if (before) throw new StoreError('already-exists', `Document already exists: ${w.ref.path}`);
      after = mergeInto({}, w.data || {}, nowIso);
      break;
    case 'set':
      after = w.merge ? mergeInto(before || {}, w.data || {}, nowIso) : mergeInto({}, w.data || {}, nowIso);
      break;
    case 'update':
      if (!before) throw new StoreError('not-found', `No document to update: ${w.ref.path}`);
      after = applyUpdate(before, w.data || {}, nowIso);
      break;
    default: throw new StoreError('invalid-argument', `Unknown write ${w.type}`);
  }
  const enc = encodeFull(adapter, after);
  const stmt = buildInsert(adapter, [{ id: w.ref.id, values: enc.values }], { lock: false });
  await client.query(stmt.text, stmt.params);
  return emitOf(w);
};

/**
 * Try to do the write in one statement on `runner` (pool or client).
 * Returns the emit record, or null when the generic path is required.
 */
const applyFast = async (runner, w, nowIso) => {
  const adapter = getAdapter(w.ref._name);
  if (w.expectVersion !== undefined) return null;
  switch (w.type) {
    case 'delete': {
      const path = adapter.refPath(w.ref.id);
      await runner.query(
        `WITH l AS (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) DELETE FROM ${adapter.table} USING l WHERE ${q(adapter.idCol)} = $2`,
        [path, adapter.typed ? w.ref.id : path]);
      return emitOf(w);
    }
    case 'create': case 'set': {
      if (w.type === 'set' && w.merge) break;
      const doc = mergeInto({}, w.data || {}, nowIso);
      const enc = encodeFull(adapter, doc);
      const stmt = buildInsert(adapter, [{ id: w.ref.id, values: enc.values }], {
        onConflict: w.type === 'create' ? 'nothing' : 'update', returning: w.type === 'create',
      });
      const res = await runner.query(stmt.text, stmt.params);
      if (w.type === 'create' && res.rowCount === 0) throw new StoreError('already-exists', `Document already exists: ${w.ref.path}`);
      return emitOf(w);
    }
    default: break;
  }
  // set{merge} / update
  const plan = planPatch(adapter, w.data || {}, w.type === 'update' ? 'update' : 'merge', nowIso);
  if (!plan) return null;
  if (w.type === 'update') {
    const stmt = buildUpdate(adapter, w.ref, plan);
    const res = await runner.query(stmt.text, stmt.params);
    return res.rowCount === 1 ? emitOf(w) : null; // 0: missing document or a guard failed -> generic path decides
  }
  const stmt = buildMergeUpsert(adapter, w.ref, plan);
  await runner.query(stmt.text, stmt.params);
  return emitOf(w);
};

const groupable = (w) => (w.type === 'create' || (w.type === 'set' && !w.merge)) && w.expectVersion === undefined;
const MAX_GROUP = 200;

/**
 * Apply a list of writes on `client` (inside an open transaction), in order.
 * Returns the emit records.
 */
const applyWrites = async (client, writes, nowIso) => {
  const emitted = [];
  let i = 0;
  while (i < writes.length) {
    const w = writes[i];
    // Group consecutive set/create to the same collection with distinct ids.
    let j = i + 1;
    if (groupable(w)) {
      const ids = new Set([w.ref.id]);
      while (j < writes.length && j - i < MAX_GROUP && groupable(writes[j]) && writes[j].type === w.type
        && writes[j].ref._name === w.ref._name && !ids.has(writes[j].ref.id)) { ids.add(writes[j].ref.id); j += 1; }
    }
    if (j - i > 1) {
      const adapter = getAdapter(w.ref._name);
      const rows = writes.slice(i, j).map((x) => ({ id: x.ref.id, values: encodeFull(adapter, mergeInto({}, x.data || {}, nowIso)).values }));
      const stmt = buildInsert(adapter, rows, { onConflict: w.type === 'create' ? 'nothing' : 'update', returning: w.type === 'create' });
      const res = await client.query(stmt.text, stmt.params);
      if (w.type === 'create' && res.rowCount !== rows.length) {
        throw new StoreError('already-exists', `Document already exists in ${w.ref._name}`);
      }
      writes.slice(i, j).forEach((x) => emitted.push(emitOf(x)));
    } else {
      emitted.push((await applyFast(client, w, nowIso)) || (await applySlow(client, w, nowIso)));
    }
    i = j;
  }
  return emitted;
};

module.exports = { buildInsert, planPatch, buildUpdate, buildMergeUpsert, applyFast, applySlow, applyWrites, emitOf };
