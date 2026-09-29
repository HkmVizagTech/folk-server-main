const crypto = require('crypto');
const { db, admin } = require('../config/firebase');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@folkvizag.app').trim().toLowerCase();
const ADMIN_NAME = process.env.ADMIN_NAME || 'Site Administrator';

// There is deliberately NO default password. The old hardcoded fallback was
// published in the client UI, so anyone could sign in as admin on any
// deployment that never set ADMIN_PASSWORD. A password now has to come from
// the caller (typed into the admin setup form) or from the ADMIN_PASSWORD env
// var, and either way it must pass the checks below.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const KNOWN_LEAKED_PASSWORDS = new Set(['admin@folk123']);

// The site owner's Firebase Auth UID. This is an identity, not a secret: only
// the person who owns that Firebase account can ever present a token for it.
// It must stay in sync with isRootAdminUid() in the client's firestore.rules.
// Read per-request (not at module load) and trimmed — a stray space in a
// pasted env var otherwise silently breaks the strict UID comparison.
const getRootAdminUid = () => (process.env.ROOT_ADMIN_UID || 'wRbvUaFiBOYeXEEtF8OuXnzGWXs2').trim();

// Recovery code: the site owner sets ADMIN_SETUP_CODE on the server and types
// the same value into the bootstrap form. Codes shorter than 12 characters are
// ignored entirely so a weak value can't be brute-forced.
const MIN_SETUP_CODE_LENGTH = 12;
const getSetupCode = () => {
  const code = (process.env.ADMIN_SETUP_CODE || '').trim();
  return code.length >= MIN_SETUP_CODE_LENGTH ? code : '';
};

// Constant-time comparison. Hashing first gives both sides the same length,
// so neither the length nor the content leaks through timing.
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

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

// Create (or reset) the shared site-admin login. Uses firebase-admin, which
// bypasses client-side firestore.rules, so no rules change is needed for this
// write.
//
// Who may call it:
//   - an existing admin,
//   - the root account (ROOT_ADMIN_UID),
//   - anyone presenting the correct ADMIN_SETUP_CODE.
// There is no "anyone may do it while no admin exists" path any more: on a
// fresh database that let the first random sign-up take over the site.
exports.createAdmin = async (data, context) => {
  if (!context.auth) {
    throw new Error('Unauthenticated');
  }
  data = data && typeof data === 'object' ? data : {};
  const callerUid = context.auth.uid;

  const callerDoc = await db.collection('users').doc(callerUid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().role : null;
  const isRoot = callerUid === getRootAdminUid();

  let setupCodeValid = false;
  const submittedCode = typeof data.setupCode === 'string' ? data.setupCode.trim() : '';
  if (submittedCode) {
    if (recentFailures(callerUid).length >= MAX_SETUP_CODE_FAILURES) {
      throw new Error('Too many wrong setup codes. Please wait 15 minutes and try again.');
    }
    const serverCode = getSetupCode();
    setupCodeValid = serverCode !== '' && safeEqual(submittedCode, serverCode);
    if (!setupCodeValid) recordFailure(callerUid);
  }

  const isAuthorized = callerRole === 'admin' || isRoot || setupCodeValid;
  if (!isAuthorized) {
    // Details for the site owner go to the server log, not to the caller.
    console.warn(
      `createAdmin denied: uid=${callerUid} role=${callerRole || '(no profile)'} ` +
      `setupCode=${submittedCode ? 'wrong' : 'none'} setupCodeConfigured=${getSetupCode() !== ''}`
    );
    throw new Error(
      submittedCode
        ? 'That setup code was not accepted.'
        : `Only an existing admin, the site owner's account, or someone with the server's setup code can do this. Your UID is ${callerUid}.`
    );
  }

  // Password: typed by the caller, else the ADMIN_PASSWORD env var.
  const provided = typeof data.password === 'string' && data.password !== '' ? data.password : null;
  const password = provided ?? process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    throw new Error(`Enter a password for the admin login (at least ${MIN_PASSWORD_LENGTH} characters).`);
  }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) {
    throw new Error(provided ? passwordProblem : `The server's ADMIN_PASSWORD is not usable: ${passwordProblem}`);
  }

  // The target account is ALWAYS the configured admin email. The caller used
  // to be able to pass any uid/email here, which let them reset the password
  // of (and grant admin to) any account on the site.
  let userRecord = null;
  try {
    userRecord = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }

  if (!userRecord) {
    try {
      userRecord = await admin.auth().createUser({
        email: ADMIN_EMAIL,
        password,
        displayName: ADMIN_NAME,
        emailVerified: true,
      });
    } catch (error) {
      // Two setup clicks raced each other: the other one created it first.
      if (error.code !== 'auth/email-already-exists') throw error;
      userRecord = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    }
  }

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

  // Ensure the Firestore profile says admin (Admin SDK bypasses rules).
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
  // yet an admin — promote their own account too, so they are not locked out
  // of the portal while the shared login details are being sorted out.
  let callerPromoted = false;
  if (callerUid !== uid && callerRole !== 'admin') {
    await db.collection('users').doc(callerUid).set(
      {
        role: 'admin',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    callerPromoted = true;
  }

  console.log(`createAdmin: admin login ${ADMIN_EMAIL} (${uid}) reset by ${callerUid}${callerPromoted ? ', caller promoted' : ''}.`);

  // The password is never echoed back.
  return {
    uid,
    username: ADMIN_USERNAME,
    email: ADMIN_EMAIL,
    role: 'admin',
    passwordSource: provided ? 'provided' : 'server',
    callerPromoted,
  };
};
