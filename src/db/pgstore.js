'use strict';

/**
 * Facade: the Postgres document store with the Firestore Admin SDK's API.
 * The implementation lives in ./store (typed tables from ./schema); this file
 * only keeps the import path the rest of the server uses.
 */
const store = require('./store');

module.exports = {
  PgStore: store.PgStore,
  Ts: store.Ts,
  StoreError: store.StoreError,
  revive: store.revive,
  toJson: store.toJson,
  mergeInto: store.mergeInto,
  applyUpdate: store.applyUpdate,
  matchesFilter: store.matchesFilter,
  getPath: store.getPath,
  splitPath: store.splitPath,
  autoId: store.autoId,
  NAME_RE: store.NAME_RE,
  OP: store.OP,
};
