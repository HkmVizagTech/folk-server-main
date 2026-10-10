const { db, admin } = require('../config/firebase');
const { validateAdminOrHead } = require('../middlewares/auth');
const crypto = require('crypto');
const { HttpsError } = require('../utils/errors');
const { optionalString, asObject } = require('../utils/ids');
const policies = require('../db/policies');
const { loadCtx } = require('../db/dataApi');
const log = require('../utils/logger').create('event');

exports.createEvent = async (data, context) => {
  const user = await validateAdminOrHead(context);
  data = asObject(data);

  const title = optionalString(data.title);
  const category = optionalString(data.category);
  const date = optionalString(data.date);

  if (!title || !category || !date) {
    throw new HttpsError('invalid-argument', 'Missing required event fields');
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

  // Optional audience, with the same rules as the data API's events policy:
  // an admin may publish to anyone, a folks head only to their own members
  // or the residency. Left out = public, as before.
  const audience = optionalString(data.audience);
  if (audience) {
    if (!policies.EVENT_AUDIENCES.includes(audience) || (audience === 'all' && user.role !== 'admin')) {
      throw new HttpsError('invalid-argument', 'Invalid audience for this event');
    }
    eventData.audience = audience;
    eventData.ownerId = user.uid;
  }

  const batch = db.batch();
  batch.set(eventRef, eventData);
  batch.set(db.collection('event_secrets').doc(eventRef.id), {
    attendanceToken,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  log.info(`Event ${eventRef.id} created.`);

  // Returned only to the staff member who created it, to display as a QR.
  return { success: true, eventId: eventRef.id, attendanceToken };
};

exports.getEvents = async (data, context) => {
  const ctx = await loadCtx(context || {});
  const snapshot = await db
    .collection("events")
    .orderBy("date", "asc")
    .get();

  // Strip the check-in token from events created before it moved to
  // event_secrets: this endpoint is public.
  // Same audience rule as /dbQuery: 'mine' / 'residents' events only reach
  // the people they are for, never the public.
  const events = snapshot.docs
    .map((doc) => {
      const { attendanceToken, ...rest } = doc.data();
      return { id: doc.id, ...rest };
    })
    .filter((e) => policies.canSeeEvent(ctx, e));

  return {
    success: true,
    events,
  };
};
