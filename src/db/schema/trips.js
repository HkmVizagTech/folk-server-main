'use strict';
const { t } = require('./dsl');

/** Yatras: public listing + booking. Business key: slug. */
module.exports = {
  collection: 'trips',
  table: 'trips',
  idFormat: '20-char auto id',
  columns: [
    t.text('slug'), t.text('title'), t.text('subtitle'), t.text('location'), t.text('description'),
    t.text('coverImage'), t.textArray('gallery'),
    t.date('startDate'), t.date('endDate'), t.text('durationLabel'),
    t.numeric('price', { min: 0 }), t.numeric('originalPrice', { min: 0 }), t.numeric('advanceAmount', { min: 0 }),
    t.int('capacity', { min: 0 }), t.text('eligibility'),
    t.text('status', { enum: ['draft', 'upcoming', 'ongoing', 'completed', 'cancelled'] }),
    t.bool('registrationOpen'), t.bool('onlinePaymentEnabled'), t.bool('cashPaymentEnabled'),
    t.textArray('highlights'), t.textArray('inclusions'), t.textArray('exclusions'),
    t.jsonb('itinerary'), t.jsonb('locations'),
    t.text('meetingPoint'), t.text('contactPhone'),
    t.text('createdBy'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  unique: [{ columns: ['slug'] }],
  indexes: [{ columns: ['start_date'] }],
};
