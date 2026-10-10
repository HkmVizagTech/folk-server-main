'use strict';
const { t } = require('./dsl');

/** Programs / calendar entries and RSVP counters. `date` is a human label, `dateISO` the machine date. */
module.exports = {
  collection: 'events',
  table: 'events',
  idFormat: '20-char auto id',
  columns: [
    t.text('title'), t.text('category'),
    t.text('date', { name: 'date_label' }), // e.g. "Sat, Oct 10, 6:30 PM" - NOT parseable, keep as text
    t.ts('dateISO'),
    t.text('time', { name: 'time_label' }),
    t.text('location'), t.text('description'), t.text('img'),
    t.text('audience', { enum: ['all', 'mine', 'residents'] }),
    t.text('ownerId'), t.text('ownerName'), t.text('groupId'), t.text('createdBy'),
    t.ts('createdAt'), t.ts('updatedAt'),
    t.int('attendingCount', { min: 0 }), t.int('declinedCount', { min: 0 }),
    t.int('attendees', { min: 0 }),
    t.text('status'),
  ],
  indexes: [{ columns: ['date_iso'] }, { columns: ['owner_id'] }, { columns: ['audience'] }],
};
