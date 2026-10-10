'use strict';

// Collapse any reasonable Indian phone representation to E.164 digits:
// 9876543210 -> 919876543210, +91-98765-43210 -> 919876543210, 091... -> 91...
const normalizePhone = (phone) => {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (p.length === 10) p = `91${p}`;
  return p;
};

const isValidIndianPhone = (phone) => /^91[6-9]\d{9}$/.test(normalizePhone(phone));

module.exports = { normalizePhone, isValidIndianPhone };
