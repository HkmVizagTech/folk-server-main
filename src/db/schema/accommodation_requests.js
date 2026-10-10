'use strict';
const { t } = require('./dsl');

/** Stay requests. Status changes go through the server. */
module.exports = {
  collection: 'accommodation_requests',
  table: 'accommodation_requests',
  idFormat: '20-char auto id',
  columns: [
    t.text('type'), t.int('guestCount', { min: 1 }),
    t.date('arrivalDate'), t.date('departureDate'), t.text('requirements'),
    t.text('userId'), t.text('userName'),
    t.text('status', { enum: ['pending', 'recommended', 'approved', 'rejected'] }),
    t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [
    { columns: ['user_id', 'doc_created_at DESC'] },
    { columns: ['doc_created_at DESC'] },
    { columns: ['status'] },
    { columns: ['user_id', 'status'] },
  ],
};
