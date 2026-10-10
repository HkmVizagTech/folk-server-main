'use strict';

const { db } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const sadhana = require('../services/sadhana.service');
const { HttpsError } = require('../utils/errors');

// POST /submitSadhana { rounds, date: 'YYYY-MM-DD' }
exports.submitSadhana = async (data, context) => {
  const uid = await validateAuth(context);
  const { rounds, date } = data || {};
  return sadhana.submitToday(uid, rounds, date);
};

// POST /getSadhanaMe
exports.getSadhanaMe = async (data, context) => {
  const uid = await validateAuth(context);
  return sadhana.getMine(uid);
};

// POST /getSadhanaAdmin (admin or folks_head)
exports.getSadhanaAdmin = async (data, context) => {
  const uid = await validateAuth(context);

  const callerDoc = await db.collection('users').doc(uid).get();
  const role = callerDoc.data()?.role;
  if (role !== 'admin' && role !== 'folks_head') {
    throw new HttpsError('permission-denied', 'Admin access required');
  }

  return { devotees: await sadhana.listDevotees() };
};
