'use strict';
const { t } = require('./dsl');

/** Server-only login codes. id = normalised phone 91XXXXXXXXXX. `sends` holds epoch-ms numbers. */
module.exports = {
  collection: 'otp_codes',
  table: 'otp_codes',
  idFormat: 'normalised phone, 91XXXXXXXXXX',
  columns: [
    t.text('codeHash'), t.text('code'), t.text('phone'),
    t.ts('createdAt'), t.ts('expiresAt'), t.int('attempts', { min: 0 }), t.jsonb('sends'),
  ],
  indexes: [{ columns: ['expires_at'], where: 'expires_at IS NOT NULL' }],
};
