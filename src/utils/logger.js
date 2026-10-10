'use strict';

/**
 * Tiny scoped logger (no dependencies). Every line is `[scope] message`, so
 * logs stay greppable, e.g. `[razorpay] verified payment ...`.
 *
 *   const log = require('../utils/logger').create('otp');
 *   log.info('sent', phone);
 */
const create = (scope) => {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
};

module.exports = { create, root: create('app') };
