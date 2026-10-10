'use strict';

/**
 * Field operations on plain JSON documents: the write sentinels
 * (serverTimestamp, delete, increment, arrayUnion, arrayRemove), set-merge,
 * update with dotted paths. Pure functions; the codec decides how the result
 * maps onto columns.
 */
const { StoreError } = require('./errors');
const { Ts, isPlainObject } = require('./timestamps');

const OP = '__op';

// Sentinels are normalised to { __op } objects, both for firebase-admin's
// FieldValue classes (server code) and for the wire format the browser sends.
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

module.exports = { OP, sentinel, toJson, jsonEqual, resolveValue, mergeInto, applyUpdate, splitPath, getPath };
