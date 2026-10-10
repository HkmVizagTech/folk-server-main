'use strict';

const crypto = require('crypto');

// Constant-time comparison. Hashing first gives both sides the same length,
// so neither the length nor the content leaks through timing.
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Constant-time comparison for two strings that may differ in length.
const safeEqualStrings = (a, b) => {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

const hmacSha256Hex = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

module.exports = { safeEqual, safeEqualStrings, hmacSha256Hex };
