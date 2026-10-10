'use strict';

const env = require('./config/env');
const app = require('./app');
const database = require('./services/database.service');
const { runSeeds } = require('./db/seeds');
const { ensurePhoneIndex } = require('./services/broadcast.service');
const log = require('./utils/logger').root;

// Defense-in-depth: log and keep running instead of letting one bad request
// (or a bug in any future handler) crash the whole process.
process.on('unhandledRejection', (reason) => log.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (err) => log.error('[UNCAUGHT EXCEPTION]', err));

env.warnings.forEach((w) => log.warn(w));
log.info('Starting Express backend...');

// Starts (lazily memoised) the first-start Postgres migration; requests wait on it.
const dbReady = database.init();

const server = app.listen(env.port, () => {
  log.info(`Server listening on port ${env.port}`);
  // One-off data the team could not add through the app (runs once).
  dbReady.then(() => runSeeds());
  // One-time (per version) phone index build, in the background.
  dbReady.then(() => ensurePhoneIndex())
    .then((r) => log.info('[phone-index]', r.skipped ? 'already built' : `built: ${r.updated} of ${r.scanned} profiles updated`))
    .catch((e) => log.error('[phone-index] build failed:', e.message));
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish.
const shutdown = (signal) => {
  log.info(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
