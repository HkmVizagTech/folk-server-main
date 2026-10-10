'use strict';
const { t } = require('./dsl');

/** A member's seat in a seva. Policy forces the id to <userId>_<sevaId>. */
module.exports = {
  collection: 'seva_registrations',
  table: 'seva_registrations',
  idFormat: '<userId>_<sevaId>',
  columns: [
    t.text('userId'), t.text('sevaId'), t.text('sevaTitle'), t.text('userName'), t.text('userPhone'),
    t.text('status', { enum: ['registered', 'cancelled', 'completed'] }),
    t.ts('createdAt'), t.ts('updatedAt'),
  ],
  unique: [{ columns: ['user_id', 'seva_id'] }],
  indexes: [{ columns: ['seva_id'] }],
};
