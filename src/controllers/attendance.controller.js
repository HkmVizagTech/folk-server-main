const { db, admin } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const { HttpsError } = require('../utils/errors');
const { safeEqual } = require('../utils/crypto');

exports.verifyAttendance = async (data, context) => {
  const uid = await validateAuth(context);
  const eventId = data && typeof data.eventId === 'string' ? data.eventId.trim() : '';
  const token = data && typeof data.token === 'string' ? data.token.trim().toUpperCase() : '';

  if (!eventId || !token || eventId.includes('/')) {
    throw new HttpsError('invalid-argument', 'Missing eventId or token');
  }

  const eventDoc = await db.collection("events").doc(eventId).get();
  if (!eventDoc.exists) {
    throw new HttpsError('not-found', 'Event not found');
  }

  // Only tokens kept in event_secrets count. Events created before the token
  // moved there had it on the public event document, where anyone could read
  // it, so those can't be self-checked-in (staff can still scan people in).
  const secretDoc = await db.collection('event_secrets').doc(eventId).get();
  const expected = secretDoc.exists ? secretDoc.data().attendanceToken : null;
  if (!expected || !safeEqual(expected, token)) {
    throw new HttpsError('invalid-argument', 'Invalid or expired token');
  }

  // Deterministic id + create() makes a double tap (or two parallel
  // requests) record attendance once instead of racing a read-then-write.
  const attendanceRef = db.collection("attendance").doc(`${eventId}_${uid}`);
  try {
    await attendanceRef.create({
      eventId,
      uid,
      // firestore.rules and the client read attendance by `userId`.
      userId: uid,
      status: 'present',
      method: 'self-check-in',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    // gRPC ALREADY_EXISTS
    if (error.code === 6 || error.code === 'already-exists') {
      throw new HttpsError('already-exists', 'Self-check-in already recorded');
    }
    throw error;
  }

  return { success: true, message: 'Attendance recorded successfully' };
};
