'use strict';

const { Query, DocumentSnapshot } = require('./query');
const { getAdapter } = require('./codec');

const q = (n) => `"${n}"`;

class Transaction {
  constructor(store, client) {
    this._store = store;
    this._client = client;
    this._writes = [];
  }
  /**
   * Read inside the transaction. A document read takes that document's
   * advisory lock first, so nobody can change it before we commit (the
   * `v<version>` precondition the browser API checks stays true).
   */
  async get(refOrQuery) {
    if (refOrQuery instanceof Query) return refOrQuery._run(this._client);
    const ref = refOrQuery;
    const adapter = getAdapter(ref._name);
    await this._client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ref.path]);
    const { rows } = await this._client.query(
      `SELECT ${adapter.selectList} FROM ${adapter.table} WHERE ${q(adapter.idCol)} = $1`, [adapter.keyValues(ref.id)[0]]);
    return new DocumentSnapshot(ref, rows[0]);
  }
  async getAll(...refs) {
    const out = [];
    for (const r of refs) out.push(await this.get(r)); // one connection: sequential
    return out;
  }
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

module.exports = { Transaction, WriteBatch };
