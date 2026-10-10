'use strict';
const { t } = require('./dsl');

/** One check-in per user per event; "absent" is the absence of a row. */
module.exports = {
  collection: 'attendance',
  table: 'attendance',
  idFormat: '<eventId>_<userId>',
  columns: [
    t.text('userId'), t.text('uid'), t.text('name'), t.text('eventId'), t.text('session'),
    t.text('status'), // 'On-time' (client) / 'present' (server): free text on purpose
    t.text('method'), t.text('markedBy'), t.text('markedByName'),
    t.text('time', { name: 'time_label' }),
    t.ts('createdAt'), t.ts('timestamp', { name: 'recorded_at' }),
  ],
  unique: [{ columns: ['event_id', 'user_id'] }],
  indexes: [
    { columns: ['user_id'] },
    { columns: ['doc_created_at DESC'] },
  ],
};
