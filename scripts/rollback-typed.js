'use strict';

/**
 * Emergency way back to the old generic tables (see docs/MIGRATIONS.md).
 *   DATABASE_URL=postgres://... node scripts/rollback-typed.js --yes
 * Stop the server first; deploy the previous release afterwards.
 */
const env = require('../src/config/env');
const { createPool } = require('../src/db/store/pool');
const { rollbackToGeneric } = require('../src/db/rollback');

const main = async () => {
  if (!env.database.url) throw new Error('DATABASE_URL is not set');
  if (!process.argv.includes('--yes')) throw new Error('Refusing to run without --yes (stop the server first, and take a backup).');
  const pool = createPool(env.database.url, { max: 2 });
  try {
    const r = await rollbackToGeneric(pool, { log: console });
    console.log(JSON.stringify(r.collections));
  } finally {
    await pool.end();
  }
};

main().catch((e) => { console.error(e.message); process.exit(1); });
