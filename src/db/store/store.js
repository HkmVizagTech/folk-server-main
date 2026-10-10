'use strict';

/**
 * Postgres document store with the Firestore Admin SDK's API, on typed tables.
 * See ../schema for the tables, ./codec for how documents map onto rows,
 * ./query for where/orderBy, ./writes for the SQL of each write.
 */
const { createPool } = require('./pool');
const { StoreError, mapPgError, RETRYABLE } = require('./errors');
const { Ts } = require('./timestamps');
const { checkName } = require('./ids');
const { CollectionReference } = require('./query');
const { Transaction, WriteBatch } = require('./transaction');
const { applyFast, applySlow, applyWrites } = require('./writes');
const { importDocs, newReport } = require('./importer');
const { typedCollections, GENERIC_TABLE } = require('../schema');

class PgStore {
  constructor(connectionString, options = {}) {
    this.pool = createPool(connectionString, options);
    // Called with { collection, id, type } after each committed write.
    this.onWrite = null;
  }

  collection(name) { return new CollectionReference(this, checkName(name)); }

  doc(path) {
    const [name, id, ...rest] = String(path).split('/');
    if (!id || rest.length) throw new StoreError('invalid-argument', `Bad document path: ${path}`);
    return this.collection(name).doc(id);
  }

  batch() { return new WriteBatch(this); }

  /**
   * Run fn(tx) and commit its writes atomically. Reads inside lock the
   * documents they touch; serialization failures and deadlocks re-run fn.
   */
  async runTransaction(fn, { maxAttempts = 5 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const client = await this.pool.connect();
      const tx = new Transaction(this, client);
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        const emitted = await applyWrites(client, tx._writes, new Date().toISOString());
        await client.query('COMMIT');
        emitted.forEach((c) => this._emit(c));
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        lastError = e;
        if (!RETRYABLE.has(e.code) || attempt === maxAttempts) throw mapPgError(e);
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  /** Every collection that has a table here (typed ones always; generic ones when they hold documents). */
  async listCollections() {
    const { rows } = await this.pool.query(`SELECT DISTINCT collection FROM ${GENERIC_TABLE}`);
    const names = new Set([...typedCollections(), ...rows.map((r) => r.collection)]);
    return [...names].sort().map((n) => this.collection(n));
  }

  /**
   * Bulk-load documents with their own version / timestamps (migration and
   * the Firestore copy). mode: 'skip' | 'overwrite' | 'guard0' (only rows
   * still at version 0). Returns the import report.
   */
  async importDocuments(collection, docs, { mode = 'skip', migration } = {}) {
    checkName(collection);
    const client = await this.pool.connect();
    const report = newReport();
    try {
      await client.query('BEGIN');
      await importDocs(client, collection, docs, { mode, migration, report });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw mapPgError(e);
    } finally {
      client.release();
    }
    return report;
  }

  async close() { await this.pool.end(); }

  // ------------------------------------------------------------ internals
  _emit(c) {
    if (c && typeof this.onWrite === 'function') {
      try { this.onWrite(c); } catch (e) { console.error('[pg] onWrite hook failed', e.message); }
    }
  }

  async _single(write) {
    const nowIso = new Date().toISOString();
    let emitted;
    try {
      emitted = await applyFast(this.pool, write, nowIso);
      if (!emitted) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          emitted = await applySlow(client, write, nowIso);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }
    } catch (e) {
      throw mapPgError(e);
    }
    this._emit(emitted);
    return { writeTime: Ts.now() };
  }
}

module.exports = { PgStore };
