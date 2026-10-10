'use strict';
const { t } = require('./dsl');

/** WhatsApp broadcast audit log (server-written). */
module.exports = {
  collection: 'broadcasts',
  table: 'broadcasts',
  idFormat: '20-char auto id',
  columns: [
    t.text('byUid'), t.text('byName'),
    t.jsonb('audience'), // {type: 'mine'|'all'|'stage', stage?}
    t.text('templateId'), t.textArray('params'),
    t.int('total', { min: 0 }), t.int('sent', { min: 0 }), t.int('failed', { min: 0 }),
    t.ts('createdAt'),
  ],
  indexes: [{ columns: ['doc_created_at'] }],
};
