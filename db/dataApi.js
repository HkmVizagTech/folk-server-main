/**
 * Browser data API: what the website used to do straight against Firestore.
 *
 *   dbGet     { path }                                   → { id, exists, data, v }
 *   dbQuery   { collection, filters, orders, limit }     → { docs: [{ id, data, v }] }
 *   dbCommit  { writes: [{ type, path, data, merge }],
 *               preconditions: [{ path, v }] }           → { ok }
 *   dbChanges { since }                                  → { seq, collections, reset }
 *
 * Values travel as JSON: timestamps are ISO strings, special writes are
 * { __op: 'serverTimestamp' | 'increment' | 'delete' | 'arrayUnion' | 'arrayRemove' }.
 * Every read and write is checked by ./policies.js. `v` is a version token;
 * a commit whose preconditions don't match fails with 'aborted' so the
 * browser can retry its transaction, as Firestore does.
 */
const functions = require('firebase-functions');
const { admin, db, usePostgres } = require('../config/firebase');
const { NAME_RE, OP, mergeInto, applyUpdate, toJson } = require('./pgstore');
const policies = require('./policies');

const HttpsError = functions.https.HttpsError;
const MAX_WRITES = 500;
const MAX_ROWS = 2000;
const FILTER_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ------------------------------------------------------------- change feed
// Which collections changed recently, so open pages refresh within seconds
// instead of polling everything. In memory: a restart just tells browsers
// to refresh once (reset: true).
const BOOT = Date.now().toString(36);
let seq = 0;
const recent = []; // { seq, collection }
const noteChange = (collection) => {
  seq += 1;
  recent.push({ seq, collection });
  if (recent.length > 2000) recent.splice(0, recent.length - 2000);
};
if (usePostgres) db.onWrite = (c) => noteChange(c.collection);

// ---------------------------------------------------------------- helpers
const parsePath = (path) => {
  const parts = String(path || '').split('/');
  if (parts.length !== 2 || !NAME_RE.test(parts[0]) || !parts[1] || parts[1].length > 300) {
    throw new HttpsError('invalid-argument', `Bad document path: ${path}`);
  }
  return { collection: parts[0], id: parts[1] };
};

const loadCtx = async (context) => {
  const uid = context.auth ? context.auth.uid : null;
  if (!uid) return { uid: null, role: null };
  const snap = await db.collection('users').doc(uid).get();
  return { uid, role: snap.exists ? (snap.data().role || null) : null };
};

const versionOf = (snap) => {
  if (!snap || !snap.exists) return null;
  if (typeof snap.version === 'number') return `v${snap.version}`;
  const t = snap.updateTime;
  return t ? `${t.seconds}.${t.nanoseconds}` : 'x';
};

const plain = (snap) => (snap && snap.exists ? toJson(snap.data()) : null);

// Wire value → what the active database expects. Postgres takes the wire
// format as is; Firestore needs its own Timestamp / FieldValue objects.
const toBackend = (v) => {
  if (usePostgres) return v;
  const FV = admin.firestore.FieldValue;
  const walk = (x) => {
    if (typeof x === 'string') return ISO_RE.test(x) ? admin.firestore.Timestamp.fromDate(new Date(x)) : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      if (typeof x[OP] === 'string') {
        switch (x[OP]) {
          case 'serverTimestamp': return FV.serverTimestamp();
          case 'delete': return FV.delete();
          case 'increment': return FV.increment(Number(x.n || 0));
          case 'arrayUnion': return FV.arrayUnion(...(x.v || []).map(walk));
          case 'arrayRemove': return FV.arrayRemove(...(x.v || []).map(walk));
          default: throw new HttpsError('invalid-argument', `Unknown field operation ${x[OP]}`);
        }
      }
      const out = {};
      for (const [k, y] of Object.entries(x)) out[k] = walk(y);
      return out;
    }
    return x;
  };
  return walk(v);
};

const checkData = (data) => {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Document data must be an object');
  }
  if (JSON.stringify(data).length > 900000) throw new HttpsError('invalid-argument', 'Document too large');
};

// ------------------------------------------------------------------ handlers
exports.dbGet = async (data, context) => {
  const { collection, id } = parsePath(data && data.path);
  const ctx = await loadCtx(context);
  const snap = await db.collection(collection).doc(id).get();
  const doc = plain(snap);
  if (!policies.canRead(ctx, collection, id, doc)) {
    throw new HttpsError('permission-denied', 'Missing or insufficient permissions.');
  }
  return { id, exists: !!doc, data: doc, v: versionOf(snap) };
};

exports.dbQuery = async (data, context) => {
  const collection = data && data.collection;
  if (!NAME_RE.test(String(collection || ''))) throw new HttpsError('invalid-argument', 'Bad collection');
  const ctx = await loadCtx(context);
  if (!policies.canList(ctx, collection)) throw new HttpsError('permission-denied', 'Missing or insufficient permissions.');

  let q = db.collection(collection);
  for (const f of (data.filters || []).slice(0, 10)) {
    if (!f || typeof f.field !== 'string' || !FILTER_OPS.has(f.op)) throw new HttpsError('invalid-argument', 'Bad filter');
    q = q.where(f.field === '__name__' && !usePostgres ? admin.firestore.FieldPath.documentId() : f.field, f.op, toBackend(f.value));
  }
  for (const o of (data.orders || []).slice(0, 4)) {
    if (!o || typeof o.field !== 'string') throw new HttpsError('invalid-argument', 'Bad orderBy');
    q = q.orderBy(o.field, o.dir === 'desc' ? 'desc' : 'asc');
  }
  const limit = Math.min(parseInt(data.limit, 10) || MAX_ROWS, MAX_ROWS);
  q = q.limit(limit);
  const snap = await q.get();
  const docs = [];
  for (const d of snap.docs) {
    const doc = plain(d);
    if (policies.canRead(ctx, collection, d.id, doc)) docs.push({ id: d.id, data: doc, v: versionOf(d) });
  }
  return { docs };
};

exports.dbCommit = async (data, context) => {
  const writes = Array.isArray(data && data.writes) ? data.writes : [];
  const preconditions = Array.isArray(data && data.preconditions) ? data.preconditions : [];
  if (!writes.length) return { ok: true };
  if (writes.length > MAX_WRITES) throw new HttpsError('invalid-argument', `At most ${MAX_WRITES} writes per commit`);
  const ctx = await loadCtx(context);

  const parsed = writes.map((w) => {
    if (!w || !['set', 'update', 'create', 'delete'].includes(w.type)) throw new HttpsError('invalid-argument', 'Bad write');
    const loc = parsePath(w.path);
    if (w.type !== 'delete') checkData(w.data);
    return { ...w, ...loc, path: `${loc.collection}/${loc.id}` };
  });
  const pre = preconditions.map((p) => ({ ...parsePath(p.path), path: String(p.path), v: p.v === undefined ? null : p.v }));

  const touched = new Set();
  await db.runTransaction(async (tx) => {
    const snaps = new Map();
    const read = async (path) => {
      if (!snaps.has(path)) {
        const { collection, id } = parsePath(path);
        snaps.set(path, await tx.get(db.collection(collection).doc(id)));
      }
      return snaps.get(path);
    };
    for (const p of pre) await read(p.path);
    for (const w of parsed) await read(w.path);

    for (const p of pre) {
      if (versionOf(snaps.get(p.path)) !== p.v) {
        throw new HttpsError('aborted', 'The data changed while you were saving. Please try again.');
      }
    }

    // What every document will look like after the whole commit.
    const nowIso = new Date().toISOString();
    const state = new Map();
    for (const w of parsed) {
      const cur = state.has(w.path) ? state.get(w.path) : plain(snaps.get(w.path));
      let next;
      if (w.type === 'delete') next = null;
      else if (w.type === 'create') {
        if (cur) throw new HttpsError('already-exists', `Document already exists: ${w.path}`);
        next = mergeInto({}, w.data, nowIso);
      } else if (w.type === 'set') next = w.merge ? mergeInto(cur || {}, w.data, nowIso) : mergeInto({}, w.data, nowIso);
      else {
        if (!cur) throw new HttpsError('not-found', `No document to update: ${w.path}`);
        next = applyUpdate(cur, w.data, nowIso);
      }
      state.set(w.path, next);
    }

    const env = {
      getBefore: async (path) => plain(await read(path)),
      getAfter: async (path) => (state.has(path) ? state.get(path) : plain(await read(path))),
    };
    for (const [path, after] of state) {
      const { collection, id } = parsePath(path);
      const before = plain(snaps.get(path));
      if (!before && !after) continue;
      const type = !before ? 'create' : !after ? 'delete' : 'update';
      const ok = await policies.canWrite(ctx, { collection, id, type, before, after }, env);
      if (!ok) throw new HttpsError('permission-denied', `Missing or insufficient permissions (${collection}).`);
    }

    for (const w of parsed) {
      const ref = db.collection(w.collection).doc(w.id);
      touched.add(w.collection);
      if (w.type === 'delete') tx.delete(ref);
      else if (w.type === 'create') tx.create(ref, toBackend(w.data));
      else if (w.type === 'set') tx.set(ref, toBackend(w.data), w.merge ? { merge: true } : undefined);
      else tx.update(ref, toBackend(w.data));
    }
  });
  if (!usePostgres) touched.forEach(noteChange); // Postgres reports its own writes
  return { ok: true };
};

exports.dbChanges = async (data) => {
  const since = data && data.since;
  const [boot, n] = String(since || '').split(':');
  const from = parseInt(n, 10);
  const token = `${BOOT}:${seq}`;
  if (boot !== BOOT || !Number.isFinite(from) || from > seq || (recent.length && from < recent[0].seq - 1)) {
    return { seq: token, collections: [], reset: !!since };
  }
  const cols = new Set(recent.filter((r) => r.seq > from).map((r) => r.collection));
  return { seq: token, collections: [...cols], reset: false };
};

exports._noteChange = noteChange;
