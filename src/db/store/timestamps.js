'use strict';

/**
 * Timestamps are ISO strings (2026-01-02T03:04:05.678Z) that come back as Ts
 * objects: strings that also have toDate()/toMillis()/seconds, so code written
 * for Firestore Timestamps keeps working.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

module.exports = { Ts, ISO_RE, isPlainObject, revive };
