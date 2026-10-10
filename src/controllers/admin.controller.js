'use strict';

const { createOrResetAdmin } = require('../services/admin.service');
const { asObject } = require('../utils/ids');

/**
 * POST /createAdmin { password?, setupCode? }
 * Create or reset the shared `admin` login. Allowed for an existing admin,
 * the root account (ROOT_ADMIN_UID) or someone with the server's setup code.
 */
exports.createAdmin = async (data, context) => {
  if (!context.auth) {
    throw new Error('Unauthenticated');
  }
  const { setupCode, password } = asObject(data);
  return createOrResetAdmin({ callerUid: context.auth.uid, setupCode, password });
};
