const functions = require('firebase-functions');
const { db } = require('../config/firebase');

// Reusable Middleware Helper: Validate Admin or Folks Head
const validateAdminOrHead = async (context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please login first');
  }

  const userDoc = await db.collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();

  if (!userData || !['admin', 'folks_head'].includes(userData.role)) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized access');
  }

  return { uid: context.auth.uid, ...userData };
};

// Reusable Middleware Helper: Validate Regular Authed User
const validateAuth = async (context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please login first');
  }
  return context.auth.uid;
};

module.exports = {
  validateAdminOrHead,
  validateAuth
};
