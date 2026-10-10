'use strict';

const { admin, db } = require('../config/firebase');
const { HttpsError } = require('../utils/errors');
const log = require('../utils/logger').create('auth');

/**
 * Mimic the Firebase Functions context: `{ auth, rawRequest }`. `auth` is the
 * decoded Firebase ID token when a valid `Authorization: Bearer` header is
 * present, otherwise null (an invalid token is treated as signed-out).
 */
const createContext = async (req) => {
  const context = { auth: null, rawRequest: req };
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1];
    try {
      context.auth = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      log.warn('Invalid Firebase token:', error.message);
    }
  }
  return context;
};

// Reusable guard: Admin or Folks Head. Returns { uid, ...profile }.
const validateAdminOrHead = async (context) => {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Please login first');
  }

  const userDoc = await db.collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();

  if (!userData || !['admin', 'folks_head'].includes(userData.role)) {
    throw new HttpsError('permission-denied', 'Unauthorized access');
  }

  return { uid: context.auth.uid, ...userData };
};

// Reusable guard: any signed-in user. Returns the uid.
const validateAuth = async (context) => {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Please login first');
  }
  return context.auth.uid;
};

// Plain Express middleware for the raw (non-onCall) upload route: resolves the
// caller onto req.authContext, falling back to signed-out if verification blows up.
const attachAuthContext = async (req, res, next) => {
  try {
    req.authContext = await createContext(req);
  } catch (error) {
    log.error('uploadImage auth failed:', error && error.message);
    req.authContext = { auth: null, rawRequest: req };
  }
  next();
};

module.exports = { createContext, validateAdminOrHead, validateAuth, attachAuthContext };
