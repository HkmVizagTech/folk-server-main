'use strict';
const { t } = require('./dsl');

/** A guide's care log entry about a member. */
module.exports = {
  collection: 'followups',
  table: 'followups',
  idFormat: '20-char auto id',
  columns: [
    t.text('memberId'), t.text('memberName'), t.text('guideId'), t.text('guideName'),
    t.text('channel'), t.text('note'), t.date('nextDate'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [{ columns: ['member_id'] }, { columns: ['guide_id'] }, { columns: ['doc_created_at'] }],
};
