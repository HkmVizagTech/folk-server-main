'use strict';
const { t } = require('./dsl');

/** Prasadam received at an event (scanner only). */
module.exports = {
  collection: 'prasadam_logs',
  table: 'prasadam_logs',
  idFormat: '<eventId>_<userId>',
  columns: [
    t.text('userId'), t.text('name'), t.text('eventId'), t.text('eventTitle'),
    t.bool('received'), t.ts('timestamp', { name: 'recorded_at' }),
  ],
  unique: [{ columns: ['event_id', 'user_id'] }],
  indexes: [{ columns: ['user_id'] }, { columns: ['recorded_at DESC'] }],
};
