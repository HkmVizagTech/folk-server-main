const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const crypto = require('crypto');
const functions = require('firebase-functions');

const optionalString = (value) => (typeof value === 'string' ? value.trim() : '');

exports.createEvent = async (data, context) => {
  const user = await validateAdminOrHead(context);
  data = data && typeof data === 'object' ? data : {};

  const title = optionalString(data.title);
  const category = optionalString(data.category);
  const date = optionalString(data.date);

  if (!title || !category || !date) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required event fields');
  }

  // Unique 8-character self-check-in token. It lives in `event_secrets`,
  // which no client can read, NOT on the event itself: events are publicly
  // readable (landing page), so a token stored there let anyone check in to
  // any event without attending.
  const attendanceToken = crypto.randomBytes(4).toString('hex').toUpperCase();
  const eventRef = db.collection("events").doc();

  const eventData = {
    title,
    category,
    date,
    // Firestore rejects `undefined`, so optional fields default to ''.
    time: optionalString(data.time),
    location: optionalString(data.location),
    description: optionalString(data.description),
    createdBy: user.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (user.role === 'folks_head') {
    eventData.groupId = user.uid; // Bound to their local group explicitly
  }

  const batch = db.batch();
  batch.set(eventRef, eventData);
  batch.set(db.collection('event_secrets').doc(eventRef.id), {
    attendanceToken,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  console.log(`Event ${eventRef.id} created. Notifying devotees...`);

  // Returned only to the staff member who created it, to display as a QR.
  return { success: true, eventId: eventRef.id, attendanceToken };
};

exports.getEvents = async () => {
  const snapshot = await db
    .collection("events")
    .orderBy("date", "asc")
    .get();

  // Strip the check-in token from events created before it moved to
  // event_secrets: this endpoint is public.
  const events = snapshot.docs.map((doc) => {
    const { attendanceToken, ...rest } = doc.data();
    return { id: doc.id, ...rest };
  });

  return {
    success: true,
    events,
  };
};
