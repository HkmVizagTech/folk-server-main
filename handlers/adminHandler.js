const { db, admin } = require('../config/firebase');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@folk123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@folkvizag.app';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Site Administrator';

// The one hardcoded root account. Only this Firebase Auth UID (or an already
// elevated admin) may bootstrap the shared admin login below. A UID is a
// real Firebase identity that cannot be spoofed from the browser.
// Override via the ROOT_ADMIN_UID env var to hand bootstrap rights to the
// site owner's own account without editing Firestore by hand.
// Read per-request (not at module load) and trimmed — a stray space in a
// pasted env var otherwise silently breaks the strict UID comparison.
const getRootAdminUid = () => (process.env.ROOT_ADMIN_UID || 'wRbvUaFiBOYeXEEtF8OuXnzGWXs2').trim();

// One-time recovery code: the site owner sets ADMIN_SETUP_CODE on the server
// and types the same value into the bootstrap form. This proves server
// ownership without depending on UID matching — useful when the mystery
// admin's identity (or a UID typo) blocks the normal path.
const getSetupCode = () => (process.env.ADMIN_SETUP_CODE || '').trim();

const maskUid = (uid) => {
  const u = String(uid || '');
  if (u.length <= 8) return u ? '****' : '(not set)';
  return `${u.slice(0, 4)}…${u.slice(-4)}`;
};

// Best-effort, human-readable hint about WHICH account currently holds the
// admin role — the site owner needs this to sign in with it (or demote it in
// the Firebase console). The email is partially masked so this doesn't leak
// a usable credential to other signed-in users.
const describeExistingAdmin = async () => {
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').limit(1).get();
    if (snap.empty) return '';
    const d = snap.docs[0].data() || {};
    const email = String(d.email || '');
    const at = email.indexOf('@');
    const masked = at > 0 ? `${email.slice(0, 2)}***${email.slice(at)}` : '';
    if (d.name && masked) return `${d.name} (${masked})`;
    return d.name || masked || 'an unrecognized account';
  } catch (error) {
    return '';
  }
};

// Create (or sync) the shared site-admin login: username `admin` with password
// `admin@folk123`. Uses firebase-admin, which bypasses client-side
// firestore.rules, so no rules change is needed for this write.
exports.createAdmin = async (data, context) => {
  if (!context.auth) {
    throw new Error('Unauthenticated');
  }

  const callerDoc = await db.collection('users').doc(context.auth.uid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().role : null;
  const rootUid = getRootAdminUid();

  // Authorized if: already an admin, OR the caller's UID matches the
  // configured root UID, OR the caller presents the current setup code.
  const setupCode = String(data?.setupCode || '').trim();
  const setupCodeValid = setupCode !== '' && setupCode === getSetupCode();
  const isAuthorized = callerRole === 'admin' || context.auth.uid === rootUid || setupCodeValid;

  // Bootstrap exception: until the very first admin exists on the site, ANY
  // signed-in user may provision the shared admin login. This is what lets the
  // site owner get started from a fresh database (there is no pre-existing
  // admin to click "create" for them). Security returns as soon as the first
  // admin profile exists.
  let existingAdminCount = 0;
  if (!isAuthorized) {
    try {
      const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').limit(1).get();
      existingAdminCount = adminsSnapshot.size;
    } catch (error) {
      console.error('createAdmin: error checking existing admins:', error);
    }
  }

  if (!isAuthorized && existingAdminCount > 0) {
    const holder = await describeExistingAdmin();
    // Full diagnosis so a failed bootstrap is never a guessing game:
    // - caller UID: full (it's the caller's own identity)
    // - configured ROOT_ADMIN_UID: masked, enough to spot a mismatch/typo
    // - server uptime: exposes "env var added but this process never restarted"
    //   (usually means the var went on a different Railway service)
    throw new Error(
      `Admins only — this site already has an admin${holder ? `: ${holder}` : ''}. ` +
      `Bootstrap check: your UID=${context.auth.uid}; ` +
      `server ROOT_ADMIN_UID=${maskUid(rootUid)}; setup code: ${setupCode ? 'provided but not accepted' : 'not provided'}; ` +
      `your role=${callerRole || '(no profile)'}; ` +
      `server booted ${Math.round(process.uptime())}s ago. ` +
      'If the masked UID does not match yours, or the code was not accepted, the env var is wrong or set on a different service — fix it on the service serving this URL and let it redeploy (check uptime).'
    );
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
    try {
      userRecord = await admin.auth().createUser({
        email: data.email || ADMIN_EMAIL,
        password: data.password || ADMIN_PASSWORD,
        displayName: data.name || ADMIN_NAME,
        emailVerified: true,
      });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') {
        // The shared login was created before (possibly with a different
        // password, or a previous run crashed mid-way). Take the account over
        // and sync its credentials below instead of failing.
        userRecord = await admin.auth().getUserByEmail(data.email || ADMIN_EMAIL);
      } else {
        throw error;
      }
    }
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

  // The caller proved server ownership (root UID or setup code) but was not
  // yet an admin — promote their own account too, so they are not locked out
  // of the portal while the shared login details are being sorted out.
  let callerPromoted = false;
  if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
    await db.collection('users').doc(context.auth.uid).set(
      {
        role: 'admin',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    callerPromoted = true;
  }

  return {
    uid,
    username: ADMIN_USERNAME,
    email: (data.email || ADMIN_EMAIL).toLowerCase(),
    password: data.password || ADMIN_PASSWORD,
    role: 'admin',
    callerPromoted,
  };
};