'use strict';
const { t } = require('./dsl');

/** Daily chanting log, one per user per IST calendar day. */
module.exports = {
  collection: 'sadhana_logs',
  table: 'sadhana_logs',
  idFormat: '<uid>_<YYYY-MM-DD> (IST date)',
  columns: [
    t.text('userId'), t.date('date', { name: 'log_date' }), t.text('userName'),
    t.int('target', { min: 0 }), t.int('roundsCompleted', { min: 0 }),
    t.int('progressPercentage', { min: 0, max: 100 }),
    t.int('streak', { min: 0 }), t.int('score'),
    t.text('status'), t.bool('completed'),
    t.jsonb('bonusClaimed'), // int[] read by the client, never written today
    t.ts('createdAt'), t.ts('updatedAt'),
  ],
  unique: [{ columns: ['user_id', 'log_date'] }],
  indexes: [{ columns: ['user_id', 'log_date DESC'] }],
};
