const { admin, db } = require('../config/firebase');
const otpService = require('../services/otpService');

const ELEVATED_ROLES = ['admin', 'folks_head'];

// Find the Firebase Auth UID that belongs to this (already OTP-verified) phone.
//
// Order of trust:
//   1) Firebase Auth's own phone registry. A number only gets there through
//      this OTP flow (or Firebase phone auth), so it's proven ownership.
//   2) A users/{uid} profile whose `phone` field matches. That field is NOT
//      verified: a devotee can type any number into their own profile, and
//      staff can edit devotee profiles. So this step is restricted:
//        - elevated accounts (admin / folks_head) are never matched this way,
//          otherwise anyone who got a phone onto an admin profile could log in
//          as that admin;
//        - if several profiles claim the number, nothing is matched — we can't
//          tell which one is the real owner.
//      When a match is found, the number is written into the account's Auth
//      record, so the next login takes path 1.
// Returns { uid } or { uid: null } when a new account should be created, or
// throws with a user-facing message when the login must be refused.
const findUidByPhone = async (phone) => {
  const e164 = `+${phone}`;

  try {
    const rec = await admin.auth().getUserByPhoneNumber(e164);
    return { uid: rec.uid };
  } catch (error) {
    if (error.code !== 'auth/phone-number-not-found' && error.code !== 'auth/user-not-found') {
      throw error;
    }
  }

  // Collect every profile that claims this number, across stored formats.
  // The bounded scan catches '+91 98765 43210' style entries the admin
  // console produced; fine for a community-size database.
  const candidates = new Map();
  for (const raw of [phone, e164, phone.slice(2)]) {
    const snap = await db.collection('users').where('phone', '==', raw).limit(5).get();
    snap.docs.forEach((doc) => candidates.set(doc.id, doc.data()));
  }
  const scan = await db.collection('users').limit(1000).get();
  scan.docs.forEach((doc) => {
    const p = doc.data().phone;
    if (p && otpService.normalizePhone(p) === phone) candidates.set(doc.id, doc.data());
  });

  if (candidates.size === 0) return { uid: null };

  if (candidates.size > 1) {
    console.warn(`[OTP] ${candidates.size} profiles claim +${phone}: ${[...candidates.keys()].join(', ')}`);
    throw new Error(
      'This number is on more than one account. Please sign in with your email or Google account, or ask the FOLK team to fix your profile.'
    );
  }

  const [[uid, profile]] = [...candidates.entries()];
  if (ELEVATED_ROLES.includes(profile.role)) {
    console.warn(`[OTP] Refused phone login into elevated account ${uid} (${profile.role}) via profile phone.`);
    throw new Error(
      'Staff accounts can\'t sign in with a phone number here. Please sign in with your email or Google account.'
    );
  }

  let rec;
  try {
    rec = await admin.auth().getUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      // A profile the staff created for someone who never had a login (e.g.
      // "Add Devotee"). Create the Auth account under that same UID so the
      // profile and its history are theirs.
      try {
        await admin.auth().createUser({ uid, phoneNumber: e164 });
      } catch (createError) {
        if (createError.code !== 'auth/uid-already-exists') throw createError;
      }
      return { uid };
    }
    throw error;
  }

  // The account already has a DIFFERENT verified number: the profile field is
  // stale or was edited, so it doesn't prove this phone owns the account.
  if (rec.phoneNumber && rec.phoneNumber !== e164) {
    throw new Error(
      'This number doesn\'t match the phone on that account. Please sign in with your email or Google account.'
    );
  }

  // The account signs in with email or Google. Its owner could have typed
  // anyone's number into their profile, so a matching profile phone doesn't
  // prove it's the same person; linking here would drop the phone's real
  // owner into someone else's account. They must use that sign-in method.
  const otherProviders = (rec.providerData || []).filter((p) => p.providerId !== 'phone');
  if (otherProviders.length > 0) {
    throw new Error(
      'This number is saved on an account that signs in with email or Google. Please sign in that way.'
    );
  }

  if (!rec.phoneNumber) {
    try {
      await admin.auth().updateUser(uid, { phoneNumber: e164 });
    } catch (error) {
      // Another account grabbed the number in the meantime — log in there.
      if (error.code === 'auth/phone-number-already-exists') {
        const owner = await admin.auth().getUserByPhoneNumber(e164);
        return { uid: owner.uid };
      }
      throw error;
    }
  }
  return { uid };
};

// POST /sendOtp  { phone }
exports.sendOtp = async (data) => {
  const phone = otpService.normalizePhone(data && data.phone);
  if (!otpService.isValidIndianPhone(phone)) {
    throw new Error('Please enter a valid Indian mobile number (e.g. +91 9876543210).');
  }

  const code = otpService.generateOTP();
  const issued = await otpService.issueOTP(phone, code);
  if (!issued.ok) throw new Error(issued.reason);

  const delivered = await otpService.sendOTPviaWhatsApp(phone, code);

  // If a Flaxxa key is configured, a failed delivery must surface as an error
  // so nobody is told "OTP sent" when nothing arrived. Gating on the key (not
  // NODE_ENV) means this holds on any deployment, however NODE_ENV is set.
  // The local dev escape hatch below only applies when no key exists at all.
  if (otpService.isConfigured() && !delivered) {
    await otpService.clearOTP(phone);
    throw new Error('Could not send the OTP right now. Please try again in a moment.');
  }

  const result = { sent: delivered, ttlSeconds: otpService.OTP_TTL_MS / 1000 };
  // Only hand the code back when running locally with no WhatsApp provider.
  // NODE_ENV must be explicitly 'development' — an unset NODE_ENV on a real
  // deployment would otherwise leak every code to whoever asks for it.
  if (process.env.NODE_ENV === 'development' && !otpService.isConfigured()) result.devCode = code;
  return result;
};

// POST /verifyOtp  { phone, otp }
exports.verifyOtp = async (data) => {
  const phone = otpService.normalizePhone(data && data.phone);
  const otp = data && data.otp;
  if (!otpService.isValidIndianPhone(phone) || !String(otp || '').trim()) {
    throw new Error('Phone number and OTP are required.');
  }

  const { ok, reason } = await otpService.verifyOTP(phone, otp);
  if (!ok) throw new Error(reason);

  // Reuse the existing account for this phone; otherwise create a fresh
  // Firebase Auth identity (no profile yet — the client's `requiresRole`
  // flow collects the name and writes the users/{uid} doc on first login).
  let { uid } = await findUidByPhone(phone);
  if (!uid) {
    try {
      const rec = await admin.auth().createUser({ phoneNumber: `+${phone}`, displayName: '' });
      uid = rec.uid;
    } catch (error) {
      if (error.code === 'auth/phone-number-already-exists') {
        const rec = await admin.auth().getUserByPhoneNumber(`+${phone}`);
        uid = rec.uid;
      } else {
        throw error;
      }
    }
  }

  const rec = await admin.auth().getUser(uid);
  if (rec.disabled) {
    throw new Error('This account has been disabled. Please contact the FOLK team.');
  }

  const customToken = await admin.auth().createCustomToken(uid);
  return { customToken, uid, phone: `+${phone}` };
};
