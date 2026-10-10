'use strict';

/** Build the old generic tables (what the pre-typed store created) and fill them from the fixtures. */
const { FIXTURES } = require('./fixtures');

const createLegacyTables = async (pool, fixtures = FIXTURES) => {
  const stamps = {};
  for (const [name, docs] of Object.entries(fixtures)) {
    await pool.query(`
      CREATE TABLE "${name}" (
        id text PRIMARY KEY,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        version bigint NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "${name}_data_gin" ON "${name}" USING gin (data jsonb_path_ops);
      CREATE INDEX "${name}_user_id" ON "${name}" ((data->>'userId'));`);
    let n = 0;
    for (const d of docs) {
      n += 1;
      const version = d.version ?? n + 2;
      const created = new Date(Date.UTC(2026, 0, n)).toISOString();
      const updated = new Date(Date.UTC(2026, 5, n, 12, 30, 15, 250)).toISOString();
      await pool.query('INSERT INTO "' + name + '" (id, data, version, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4, $5)',
        [d.id, JSON.stringify(d.data), version, created, updated]);
      stamps[`${name}/${d.id}`] = { version, created, updated };
    }
  }
  return stamps;
};

module.exports = { createLegacyTables };
