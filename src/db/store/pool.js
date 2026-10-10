'use strict';

const { Pool, types } = require('pg');

// Numbers and dates the way documents need them: bigint / numeric as JS
// numbers (amounts are numeric(12,2), counters bigint), date as 'YYYY-MM-DD'.
// timestamptz stays a JS Date; the codec turns it into the exact ISO string.
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 };
const parsers = {
  [OID.INT8]: (s) => Number(s),
  [OID.NUMERIC]: (s) => Number(s),
  [OID.DATE]: (s) => s,
};
const typeParsers = { getTypeParser: (oid, format) => parsers[oid] || types.getTypeParser(oid, format) };

const sslFor = (connectionString) => (
  /sslmode=require|\.proxy\.rlwy\.net|neon\.tech|supabase/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined
);

/**
 * Pool with sensible limits: bounded size, idle clients released, a connect
 * timeout (fail fast instead of hanging a request), and server-side timeouts
 * so a stuck statement or a transaction left open cannot hold locks forever.
 */
const createPool = (connectionString, options = {}) => {
  const pool = new Pool({
    connectionString,
    ssl: options.ssl !== undefined ? options.ssl : sslFor(connectionString),
    max: options.max || 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10000,
    statement_timeout: options.statementTimeoutMs ?? 30000,
    idle_in_transaction_session_timeout: options.idleInTransactionMs ?? 30000,
    application_name: options.applicationName || 'folk-server',
    types: typeParsers,
  });
  pool.on('error', (e) => console.error('[pg] idle client error', e.message));
  return pool;
};

module.exports = { createPool, typeParsers };
