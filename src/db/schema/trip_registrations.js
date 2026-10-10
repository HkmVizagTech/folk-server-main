'use strict';
const { t } = require('./dsl');

/** A seat booking, also holding the payment pointer and the cash attestation. */
module.exports = {
  collection: 'trip_registrations',
  table: 'trip_registrations',
  idFormat: '20-char auto id',
  columns: [
    t.text('tripId'), t.text('tripSlug'), t.text('tripTitle'),
    t.text('userId'), t.text('userName'), t.text('userPhone'), t.text('userEmail'),
    t.int('seats', { min: 1, max: 20 }),
    t.numeric('amountDue', { min: 0 }),
    t.text('paymentMode', { enum: ['online', 'cash'] }),
    t.text('paymentOrderId'),
    t.text('status', { enum: ['pending', 'confirmed', 'waitlisted', 'cancelled'] }),
    t.text('confirmedBy'), t.text('staffNotes'),
    t.bool('cashCollected'), t.numeric('cashAmount', { min: 0 }), t.ts('cashCollectedAt'), t.text('cashCollectedBy'),
    t.jsonb('travellers'), // [{name, age, gender, idType, idNumber, college, course, year, relation}]
    t.text('emergencyContact'), t.text('pickup'), t.text('travellerNotes'),
    t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [
    { columns: ['user_id'] },
    { columns: ['trip_id', 'status'] }, // also serves WHERE trip_id = ?
    { columns: ['payment_order_id'], where: 'payment_order_id IS NOT NULL' },
  ],
};
