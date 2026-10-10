'use strict';

const env = require('../config/env');
const { db, usePostgres } = require('../config/firebase');
const migrator = require('../db/migrator');
const migrate = require('../db/migrate');
const log = require('../utils/logger').create('db');

// On start: (1) apply pending schema migrations (typed tables, legacy data
// copy - src/db/migrations), then (2) on the very first start with Postgres
// copy the data over from Firestore. Requests wait for that (usually seconds).
// init() is lazy and memoised, so loading the app has no side effects until
// the first POST or until server.js calls it.
let readyPromise = null;
let initError = null;

const runSchemaMigrations = async () => {
  if (!usePostgres || !env.database.autoMigrate) return;
  const r = await migrator.migrate(db.pool, { log });
  if (!r.upToDate) log.info('schema migrated:', r.applied.map((m) => m.version).join(', '));
};

const init = () => {
  if (!readyPromise) {
    readyPromise = runSchemaMigrations()
      .then(() => migrate.ensureMigrated())
      .then((r) => { log.info('ready', r.skipped ? `(${r.skipped})` : JSON.stringify(r.counts)); })
      .catch((e) => { initError = e; log.error('MIGRATION FAILED:', e); });
  }
  return readyPromise;
};

const getError = () => initError;

module.exports = { init, getError };
