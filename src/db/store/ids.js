'use strict';

const crypto = require('crypto');
const { StoreError } = require('./errors');

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

// 20-char Firestore-style auto id.
const autoId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let id = '';
  for (let i = 0; i < 20; i += 1) id += chars[bytes[i] % chars.length];
  return id;
};

const checkName = (name) => {
  if (!NAME_RE.test(name)) throw new StoreError('invalid-argument', `Bad collection name: ${name}`);
  return name;
};

module.exports = { NAME_RE, autoId, checkName };
