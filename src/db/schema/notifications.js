'use strict';
const { t } = require('./dsl');

module.exports = {
  collection: 'notifications',
  table: 'notifications',
  idFormat: '20-char auto id',
  columns: [
    t.text('type'), t.text('title'), t.text('message'), t.text('link'),
    t.ts('createdAt'), t.text('createdBy'),
  ],
  indexes: [{ columns: ['doc_created_at DESC'] }],
};
