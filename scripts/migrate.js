'use strict';

/**
 * Apply schema migrations by hand:
 *   DATABASE_URL=postgres://... npm run migrate            apply everything pending
 *   DATABASE_URL=postgres://... npm run migrate -- --status  list applied / pending
 * (The server does the same on start unless DB_AUTO_MIGRATE=false.)
 */
const env = require('../src/config/env');
const { createPool } = require('../src/db/store/pool');
const { migrate, status } = require('../src/db/migrator');

const main = async () => {
  if (!env.database.url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(env.database.url, { max: 2 });
  try {
    if (process.argv.includes('--status')) {
      for (const m of await status(pool)) {
        console.log(`${m.applied ? 'applied ' : 'PENDING '} ${m.file}${m.changed ? '  (file changed since applied!)' : ''}${m.appliedAt ? `  ${m.appliedAt.toISOString()}` : ''}`);
      }
      return;
    }
    const r = await migrate(pool, { log: console });
    console.log(r.upToDate ? 'Already up to date.' : `Applied: ${r.applied.map((m) => m.file || `${m.version}_${m.name}`).join(', ')}`);
  } finally {
    await pool.end();
  }
};

main().catch((e) => { console.error(e.message); process.exit(1); });
