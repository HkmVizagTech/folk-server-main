'use strict';
const { t } = require('./dsl');

/** Server bookkeeping documents: migration, seeds, phoneIndex. */
module.exports = {
  collection: 'system',
  table: 'system',
  idFormat: 'migration | seeds | phoneIndex',
  columns: [
    t.text('source'), t.text('projectId'), t.jsonb('counts'), t.bool('firestoreLocked'),
    t.bigint('durationMs'), t.ts('completedAt'),
    t.textArray('done'), t.ts('updatedAt'),
    t.int('version'), t.int('scanned'), t.int('updated'), t.ts('builtAt'),
  ],
};
