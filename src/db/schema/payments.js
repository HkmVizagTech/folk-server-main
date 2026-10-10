'use strict';
const { t } = require('./dsl');

/** Razorpay order ledger (server-written). Both rupees and paise are kept. Never FK'd: a ledger must survive deletions. */
module.exports = {
  collection: 'payments',
  table: 'payments',
  idFormat: 'Razorpay order id (order_XXXX)',
  columns: [
    t.text('userId'),
    t.numeric('amount', { min: 0 }), t.bigint('amountPaise', { min: 0 }), t.text('currency'),
    t.text('purpose', { enum: ['trip', 'donation'] }),
    t.text('tripId'), t.text('tripRegistrationId'),
    t.text('eventId'), // misnamed: holds the TRIP id for trip payments
    t.text('status', { enum: ['pending', 'completed', 'failed', 'amount_mismatch'] }),
    t.bool('verified'), t.text('paymentId'), t.text('method'), t.text('verifiedBy'),
    t.ts('capturedAt'), t.ts('failedAt'), t.text('failureReason'), t.jsonb('lastFailedAttempt'),
    t.bigint('paidAmountPaise', { min: 0 }), t.text('paidCurrency'),
    t.ts('createdAt'), t.ts('updatedAt'),
  ],
  indexes: [
    { columns: ['user_id'] },
    { columns: ['trip_registration_id'], where: 'trip_registration_id IS NOT NULL' },
    { columns: ['status'] },
  ],
};
