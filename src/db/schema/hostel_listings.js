'use strict';
const { t } = require('./dsl');

/** Hostel / dorm listings (public read). `active` absent means active. */
module.exports = {
  collection: 'hostel_listings',
  table: 'hostel_listings',
  idFormat: '20-char auto id',
  columns: [
    t.text('name'), t.text('description'), t.int('capacity', { min: 0 }), t.textArray('amenities'),
    t.text('img'), t.bool('active'), t.text('createdBy'), t.ts('createdAt'), t.ts('updatedAt'),
  ],
};
