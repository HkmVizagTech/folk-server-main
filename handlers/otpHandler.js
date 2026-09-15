const { admin, db } = require('../config/firebase');
const otpService = require('../services/otpService');

// Attempt to find the Firebase Auth UID that already belongs to this phone.
// Priority: an app profile in `users` whose stored phone matches (email and
// phone signups alike), then Firebase's own phone-number registry (accounts
// previously created by this phone flow). Returns null when no account exists.
const findUidByPhone = async (phone) => {
  // 1) users collection — exact match on a couple of stored formats.
  for (const raw of [phone, `+${phone}`]) {
    const snap = await db.collection('users').where('phone', '==', raw).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }

  // 2) users collection — normalized scan, catches '+91 98765 43210' style
  //    entries the admin console produced. Bounded scan is fine for a
  //    community-size database; the exact lookups above short-circuit it.
  const scan = await db.collection('users').limit(1000).get();
  if (!scan.empty) {
    for (const doc of scan.docs) {
      const p = doc.data().phone;
      if (p && otpService.normalizePhone(p) === phone) return doc.id;
    }
  }

  // 3) Firebase Auth registry — a previous phone-flow account.
  try {
    const rec = await admin.auth().getUserByPhoneNumber(`+${phone}`);
    return rec.uid;
  } catch (error) {
    if (error.code !== 'auth/phone-number-not-found' && error.code !== 'auth/user-not-found') {
      throw error;
    }
    return null;
  }
};

// POST /sendOtp  { phone }
exports.sendOtp = async (data) => {
  const phone = otpService.normalizePhone(data && data.phone);
  if (!otpService.isValidIndianPhone(phone)) {
    throw new Error('Please enter a valid Indian mobile number (e.g. +91 9876543210).');
  }

  const guard = await otpService.canResend(phone);
  if (!guard.ok) throw new Error(guard.reason);

  const code = otpService.generateOTP();
  const sends = (await db.collection('otp_codes').doc(phone).get()).data()?.sends || [];
  await otpService.storeOTP(phone, code, sends);

  const delivered = await otpService.sendOTPviaWhatsApp(phone, code);

  // In production an undeliverable OTP must surface as an error so nobody is
  // told "OTP sent" when nothing arrived. When no Flaxxa key is configured
  // and we're not in production, expose the code in the response so the whole
  // flow can still be exercised end-to-end locally.
  const isProd = process.env.NODE_ENV === 'production';
  if (!delivered && isProd) {
    throw new Error('Could not send the OTP right now. Please try again in a moment.');
  }

  const result = { sent: delivered, ttlSeconds: otpService.OTP_TTL_MS / 1000 };
  if (!isProd && !otpService.isConfigured()) result.devCode = code;
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

  // Reuse any existing account for this phone; otherwise create a fresh
  // Firebase Auth identity (no profile yet — the client's `requiresRole`
  // flow collects the name and writes the users/{uid} doc on first login).
  let uid = await findUidByPhone(phone);
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

  const customToken = await admin.auth().createCustomToken(uid);
  return { customToken, uid, phone: `+${phone}` };
};