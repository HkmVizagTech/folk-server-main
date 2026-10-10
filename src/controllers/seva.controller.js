'use strict';

const { validateAdminOrHead, validateAuth } = require('../middlewares/auth');
const sevas = require('../services/seva.service');
const { asObject } = require('../utils/ids');

// Admin: POST /createSeva
exports.createSeva = async (data, context) => {
  const user = await validateAdminOrHead(context);
  return sevas.create(user, asObject(data));
};

// User: POST /joinSeva { sevaId }
exports.joinSeva = async (data, context) => {
  const userId = await validateAuth(context);
  return sevas.join(userId, asObject(data).sevaId);
};

// User: POST /cancelSeva { sevaId }
exports.cancelSeva = async (data, context) => {
  const userId = await validateAuth(context);
  const sevaId = data && typeof data.sevaId === 'string' ? data.sevaId : '';
  return sevas.cancel(userId, sevaId);
};

// Admin: POST /getSevaParticipants { sevaId }
exports.getSevaParticipants = async (data, context) => {
  await validateAdminOrHead(context);
  return sevas.listParticipants(asObject(data).sevaId);
};

// Admin: POST /markSevaAttendance { registrationId, status }
exports.markAttendance = async (data, context) => {
  await validateAdminOrHead(context);
  const { registrationId, status } = asObject(data);
  return sevas.markAttendance(registrationId, status);
};

// Signed-in: POST /getSevas
exports.getSevas = async (data, context) => {
  await validateAuth(context);
  return sevas.listAll();
};

// Signed-in: POST /getMySevas
exports.getMySevas = async (data, context) => {
  const userId = await validateAuth(context);
  return sevas.listForUser(userId);
};
