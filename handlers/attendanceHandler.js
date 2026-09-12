const { db, admin } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const functions = require('firebase-functions');

exports.verifyAttendance = async (data, context) => {
  const uid = await validateAuth(context);
  const { eventId, token } = data;

  if (!eventId || !token) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing eventId or token');
  }

  const attendanceId = `${eventId}_${uid}`;
  const attendanceRef = db.collection("attendance").doc(attendanceId);
  const existing = await attendanceRef.get();

  if (existing.exists) {
    throw new functions.https.HttpsError('already-exists', 'Self-check-in already recorded');
  }

  // Validate the token strictly against the event's active token
  const eventDoc = await db.collection("events").doc(eventId).get();
  
  if (!eventDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Event not found');
  }

  if (eventDoc.data().attendanceToken !== token) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid or expired token');
  }

  // Record Attendance
  await attendanceRef.set({
    eventId,
    uid,
    tokenUsed: token,
    status: 'present',
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true, message: 'Attendance recorded successfully' };
};
