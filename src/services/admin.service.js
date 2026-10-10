'use strict';

const { db, admin } = require('../config/firebase');
const env = require('../config/env');
const { safeEqual } = require('../utils/crypto');
const log = require('../utils/logger').create('admin');

const { username: ADMIN_USERNAME, email: ADMIN_EMAIL, name: ADMIN_NAME } = env.admin;

// There is deliberately NO default password. A password has to come from the
// caller (typed into the admin setup form) or from the ADMIN_PASSWORD env var,
// and either way it must pass the checks below.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const KNOWN_LEAKED_PASSWORDS = new Set(['admin@folk123']);

// Per-account limit on wrong setup codes, so a signed-in user can't guess the
// code by calling this endpoint in a loop. In-memory is enough here: it resets
// on restart, but a restart is slow and the code is at least 12 characters.
const SETUP_CODE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SETUP_CODE_FAILURES = 5;
const setupCodeFailures = new Map(); // uid -> [timestamps]

const recentFailures = (uid) => {
  const now = Date.now();
  const list = (setupCodeFailures.get(uid) || []).filter((t) => now - t < SETUP_CODE_WINDOW_MS);
  if (list.length) setupCodeFailures.set(uid, list);
  else setupCodeFailures.delete(uid);
  return list;
};

const recordFailure = (uid) => {
  const list = recentFailures(uid);
  list.push(Date.now());
  setupCodeFailures.set(uid, list);
};

const validatePassword = (password) => {
  if (typeof password !== 'string') return 'Password must be text.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim() !== password) return 'Password cannot start or end with a space.';
  if (KNOWN_LEAKED_PASSWORDS.has(password.toLowerCase())) {
    return 'That password was published in the app and can no longer be used. Choose a new one.';
  }
  if (password.toLowerCase().includes(ADMIN_USERNAME.toLowerCase()) && password.length < 16) {
    return `A password containing "${ADMIN_USERNAME}" must be at least 16 characters.`;
  }
  return null;
};

/**
 * Decide whether the caller may create/reset the admin login. Returns
 * `{ callerRole }` or throws. Authorised: an existing admin, the root account
 * (ROOT_ADMIN_UID), or anyone presenting the correct ADMIN_SETUP_CODE. There is
 * no "anyone may do it while no admin exists" path: on a fresh database that
 * let the first random sign-up take over the site.
 */
const authorizeCaller = async (callerUid, submittedCode) => {
  const callerDoc = await db.collection('users').doc(callerUid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().role : null;
  const isRoot = callerUid === env.admin.rootUid;

  let setupCodeValid = false;
  if (submittedCode) {
    if (recentFailures(callerUid).length >= MAX_SETUP_CODE_FAILURES) {
      throw new Error('Too many wrong setup codes. Please wait 15 minutes and try again.');
    }
    const serverCode = env.admin.setupCode;
    setupCodeValid = serverCode !== '' && safeEqual(submittedCode, serverCode);
    if (!setupCodeValid) recordFailure(callerUid);
  }

  if (!(callerRole === 'admin' || isRoot || setupCodeValid)) {
    // Details for the site owner go to the server log, not to the caller.
    log.warn(
      `createAdmin denied: uid=${callerUid} role=${callerRole || '(no profile)'} ` +
      `setupCode=${submittedCode ? 'wrong' : 'none'} setupCodeConfigured=${env.admin.setupCode !== ''}`
    );
    throw new Error(
      submittedCode
        ? 'That setup code was not accepted.'
        : `Only an existing admin, the site owner's account, or someone with the server's setup code can do this. Your UID is ${callerUid}.`
    );
  }
  return { callerRole };
};

// The target account is ALWAYS the configured admin email (the caller used to
// pass any uid/email, which let them reset/promote any account).
const getOrCreateAdminAuthUser = async (password) => {
  try {
    return await admin.auth().getUserByEmail(ADMIN_EMAIL);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }
  try {
    return await admin.auth().createUser({
      email: ADMIN_EMAIL,
      password,
      displayName: ADMIN_NAME,
      emailVerified: true,
    });
  } catch (error) {
    // Two setup clicks raced each other: the other one created it first.
    if (error.code !== 'auth/email-already-exists') throw error;
    return admin.auth().getUserByEmail(ADMIN_EMAIL);
  }
};

/** Create (or reset) the shared site-admin login. See controller for the wire shape. */
const createOrResetAdmin = async ({ callerUid, setupCode, password: provided }) => {
  const submittedCode = typeof setupCode === 'string' ? setupCode.trim() : '';
  const { callerRole } = await authorizeCaller(callerUid, submittedCode);

  // Password: typed by the caller, else the ADMIN_PASSWORD env var.
  const typed = typeof provided === 'string' && provided !== '' ? provided : null;
  const password = typed ?? env.admin.password;
  if (!password) {
    throw new Error(`Enter a password for the admin login (at least ${MIN_PASSWORD_LENGTH} characters).`);
  }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) {
    throw new Error(typed ? passwordProblem : `The server's ADMIN_PASSWORD is not usable: ${passwordProblem}`);
  }

  const userRecord = await getOrCreateAdminAuthUser(password);
  const uid = userRecord.uid;
  const adminRef = db.collection('users').doc(uid);
  const adminDoc = await adminRef.get();

  // Anyone can register an email/password account from the public sign-up
  // form, so the admin email may have been claimed by someone else before
  // setup ran. If the account exists but its profile isn't already an admin,
  // treat it as untrusted: besides resetting the password, drop any phone
  // number they attached, because phone OTP login finds accounts by phone.
  const claimedByOther = !(adminDoc.exists && adminDoc.data().role === 'admin');

  // Always set the password, even when the account already existed, and
  // revoke existing sessions so nobody stays signed in with the old one.
  await admin.auth().updateUser(uid, {
    password,
    displayName: ADMIN_NAME,
    emailVerified: true,
    disabled: false,
    ...(claimedByOther && userRecord.phoneNumber ? { phoneNumber: null } : {}),
  });
  await admin.auth().revokeRefreshTokens(uid);

  // Ensure the profile says admin (Admin SDK bypasses rules).
  await adminRef.set(
    {
      uid,
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      role: 'admin',
      username: ADMIN_USERNAME,
      ...(claimedByOther ? { phone: '' } : {}),
      // Keep an existing profile's sadhana progress; only seed it on first create.
      ...(adminDoc.exists ? {} : { streak: 0, score: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // The caller proved server ownership (root UID or setup code) but was not
  // yet an admin: promote their own account too, so they are not locked out.
  let callerPromoted = false;
  if (callerUid !== uid && callerRole !== 'admin') {
    await db.collection('users').doc(callerUid).set(
      { role: 'admin', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    callerPromoted = true;
  }

  log.info(`admin login ${ADMIN_EMAIL} (${uid}) reset by ${callerUid}${callerPromoted ? ', caller promoted' : ''}.`);

  // The password is never echoed back.
  return {
    uid,
    username: ADMIN_USERNAME,
    email: ADMIN_EMAIL,
    role: 'admin',
    passwordSource: typed ? 'provided' : 'server',
    callerPromoted,
  };
};

module.exports = { createOrResetAdmin, validatePassword };
