'use strict';
const { t } = require('./dsl');

module.exports = {
  collection: 'hostel_bookings',
  table: 'hostel_bookings',
  idFormat: '20-char auto id',
  columns: [
    t.text('listingId'), t.text('listingName'), t.text('userId'), t.text('userName'),
    t.date('checkIn'), t.date('checkOut'), t.int('guestCount', { min: 1 }), t.text('notes'),
    t.text('status', { enum: ['pending', 'approved', 'rejected', 'cancelled'] }),
    t.text('staffNotes'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [
    { columns: ['user_id', 'doc_created_at DESC'] },
    { columns: ['doc_created_at DESC'] },
    { columns: ['listing_id'] },
    { columns: ['status'] },
  ],
};
