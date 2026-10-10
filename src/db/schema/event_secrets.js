'use strict';
const { t } = require('./dsl');

/** Server-only: the self check-in token of an event. id = event id. */
module.exports = {
  collection: 'event_secrets',
  table: 'event_secrets',
  idFormat: 'the event id',
  columns: [t.text('attendanceToken'), t.ts('createdAt')],
  // The one hard foreign key: the secret is meaningless without its event and
  // carries no data worth keeping, so deleting an event may delete its secret.
  // DEFERRED so a batch may write the secret before the event.
  foreignKeys: [{ columns: ['id'], references: 'events (id)', onDelete: 'CASCADE', deferrable: true }],
};
