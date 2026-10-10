'use strict';
const { t } = require('./dsl');

module.exports = {
  collection: 'contact_messages',
  table: 'contact_messages',
  idFormat: '20-char auto id',
  columns: [
    t.text('userId'), t.text('name'), t.text('phone'), t.text('email'), t.text('topic'),
    t.text('message'), t.text('status'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [{ columns: ['doc_created_at'] }],
};
