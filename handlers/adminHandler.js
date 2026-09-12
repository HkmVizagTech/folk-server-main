const { db, admin } = require('../config/firebase');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@folk123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@folkvizag.app';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Site Administrator';

// The one hardcoded root account. Only this Firebase Auth UID (or an already
// elevated admin) may bootstrap the shared admin login below. A UID is a
// real Firebase identity that cannot be spoofed from the browser.
const ROOT_ADMIN_UID = 'wRbvUaFiBOYeXEEtF8OuXnzGWXs2';

// Create (or sync) the shared site-admin login: username `admin` with password
// `admin@folk123`. Uses firebase-admin, which bypasses client-side
// firestore.rules, so no rules change is needed for this write.
exports.createAdmin = async (data, context) => {
  if (!context.auth) {
    throw new Error('Unauthenticated');
  }

  const callerDoc = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().role : null;
  const isAuthorized = callerRole === 'admin' || context.auth.uid === ROOT_ADMIN_UID;
  if (!isAuthorized) {
    throw new Error('Admins only');
  }

  let uid = data.uid || null;
  let userRecord;

  if (uid) {
    try {
      userRecord = await admin.auth().getUser(uid);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        userRecord = null;
      } else {
        throw error;
      }
    }
  }

  if (!userRecord) {
    // Create the shared admin Firebase Auth account.
    userRecord = await admin.auth().createUser({
      email: data.email || ADMIN_EMAIL,
      password: data.password || ADMIN_PASSWORD,
      displayName: data.name || ADMIN_NAME,
      emailVerified: true,
    });
    uid = userRecord.uid;
  } else {
    // Account exists — make sure the stored admin credentials still match.
    await admin.auth().updateUser(userRecord.uid, {
      password: data.password || ADMIN_PASSWORD,
      displayName: data.name || ADMIN_NAME,
    });
    uid = userRecord.uid;
  }

  // Ensure Firestore profile says admin (Admin SDK bypasses rules).
  await db.collection('users').doc(uid).set(
    {
      uid,
      email: (data.email || ADMIN_EMAIL).toLowerCase(),
      name: data.name || ADMIN_NAME,
      role: 'admin',
      username: ADMIN_USERNAME,
      streak: 0,
      score: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    uid,
    username: ADMIN_USERNAME,
    email: (data.email || ADMIN_EMAIL).toLowerCase(),
    password: data.password || ADMIN_PASSWORD,
    role: 'admin',
  };
};