'use strict';
const { t } = require('./dsl');

/** Volunteer service slots. countRegistered is the seat counter (client-maintained). */
module.exports = {
  collection: 'sevas',
  table: 'sevas',
  idFormat: '20-char auto id',
  columns: [
    t.text('title'), t.text('description'), t.text('sevaType'),
    t.date('date', { name: 'seva_date' }), t.text('time', { name: 'time_label' }),
    t.text('location'),
    t.int('maxVolunteers', { min: 0 }), t.bool('isRecurring'),
    t.int('countRegistered', { min: 0 }),
    t.text('createdBy'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [{ columns: ['seva_date'] }],
};
