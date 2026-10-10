'use strict';
const { t } = require('./dsl');

/** A member's RSVP to an event. Mock events (eventId 'mock...') have no events row, so no FK. */
module.exports = {
  collection: 'registrations',
  table: 'registrations',
  idFormat: '<eventId>_<userId>',
  columns: [
    t.text('eventId'), t.text('eventTitle'), t.text('userId'), t.text('userName'),
    t.text('token'),
    t.text('status', { enum: ['Attending', 'Not Attending', 'Cancelled'] }),
    t.ts('updatedAt'), t.ts('createdAt'),
  ],
  unique: [{ columns: ['event_id', 'user_id'] }],
  indexes: [
    { columns: ['user_id'] },
    { columns: ['token'], where: 'token IS NOT NULL' },
  ],
};
