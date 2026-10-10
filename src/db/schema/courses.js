'use strict';
const { t } = require('./dsl');

module.exports = {
  collection: 'courses',
  table: 'courses',
  idFormat: '20-char auto id',
  columns: [
    t.text('title'), t.text('description'), t.int('sessions', { min: 0, max: 1000 }), t.text('schedule'),
    t.bool('active'), t.text('createdBy'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
};
