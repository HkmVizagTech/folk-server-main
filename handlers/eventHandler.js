const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const crypto = require('crypto');
const functions = require('firebase-functions');

exports.createEvent = async (data, context) => {
  const user = await validateAdminOrHead(context);
  
  const { title, category, date, time, location, description } = data;

  if (!title || !category || !date) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required event fields');
  }

  // Generate unique 8-character attendance token
  const attendanceToken = crypto.randomBytes(4).toString('hex').toUpperCase();
  const eventId = db.collection("events").doc().id;
  
  const eventData = {
    title,
    category,
    date,
    time,
    location,
    description,
    createdBy: user.uid,
    attendanceToken,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (user.role === 'folks_head') {
    eventData.groupId = user.uid; // Bound to their local group explicitly
  }

  await db.collection("events").doc(eventId).set(eventData);

  // Mock Notification
  console.log(`Event ${eventId} created with token ${attendanceToken}. Notifying devotees...`);
  
  return { success: true, eventId, attendanceToken };
};

exports.getEvents = async () => {
  const snapshot = await db
    .collection("events")
    .orderBy("date", "asc")
    .get();

  const events = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  return {
    success: true,
    events,
  };
};