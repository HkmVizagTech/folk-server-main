const { db, admin } = require('../config/firebase');
const { validateAdminOrHead, validateAuth } = require('../middlewares/auth');
const functions = require('firebase-functions');
const { sendWhatsAppMessage } = require('../services/notificationService');

/**
 * Admin: Create a new Seva opportunity
 */
exports.createSeva = async (data, context) => {
  const user = await validateAdminOrHead(context);
  
  const { title, description, sevaType, date, time, location, maxVolunteers, isRecurring } = data;

  if (!title || !description || !sevaType || !date || !time || !location || !maxVolunteers) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required Seva fields');
  }

  const volunteers = parseInt(maxVolunteers, 10);
  if (!Number.isInteger(volunteers) || volunteers < 1 || volunteers > 10000) {
    throw new functions.https.HttpsError('invalid-argument', 'maxVolunteers must be a whole number of at least 1');
  }

  const sevaId = db.collection("sevas").doc().id;

  const sevaData = {
    title,
    description,
    sevaType,
    date,
    time,
    location,
    maxVolunteers: volunteers,
    isRecurring: !!isRecurring,
    countRegistered: 0,
    createdBy: user.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection("sevas").doc(sevaId).set(sevaData);

  // Notify (Mock)
  console.log(`Seva ${sevaId} created. Notifying devotees...`);
  // In a real app, you might fetch all devotees and send notifications
  // sendWhatsAppMessage("global", `New Seva available: ${title}`);
  
  return { success: true, sevaId };
};

/**
 * User: Join a Seva
 */
exports.joinSeva = async (data, context) => {
  const userId = await validateAuth(context);
  const { sevaId } = data;

  if (!sevaId) {
    throw new functions.https.HttpsError('invalid-argument', 'Seva ID is required');
  }

  const sevaRef = db.collection('sevas').doc(sevaId);
  const registrationId = `${userId}_${sevaId}`;
  const registrationRef = db.collection('seva_registrations').doc(registrationId);

  try {
    await db.runTransaction(async (transaction) => {
      const sevaDoc = await transaction.get(sevaRef);
      const registrationDoc = await transaction.get(registrationRef);

      if (!sevaDoc.exists) {
        throw new Error('Seva does not exist');
      }

      if (registrationDoc.exists && registrationDoc.data().status === 'registered') {
        throw new Error('You are already registered for this Seva');
      }
      // Re-joining would overwrite the staff-confirmed "completed" record.
      if (registrationDoc.exists && registrationDoc.data().status === 'completed') {
        throw new Error('You have already completed this Seva');
      }

      const sevaData = sevaDoc.data();
      if (sevaData.countRegistered >= sevaData.maxVolunteers) {
        throw new Error('Seva is already full');
      }

      // Update Seva count
      transaction.update(sevaRef, {
        countRegistered: admin.firestore.FieldValue.increment(1)
      });

      // Create Registration
      transaction.set(registrationRef, {
        userId,
        sevaId,
        status: 'registered',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('failed-precondition', error.message);
  }
};

/**
 * User: Cancel Registration
 */
exports.cancelSeva = async (data, context) => {
  const userId = await validateAuth(context);
  const sevaId = data && typeof data.sevaId === 'string' ? data.sevaId : '';

  if (!sevaId || sevaId.includes('/')) {
    throw new functions.https.HttpsError('invalid-argument', 'Seva ID is required');
  }

  const registrationId = `${userId}_${sevaId}`;
  const registrationRef = db.collection('seva_registrations').doc(registrationId);
  const sevaRef = db.collection('sevas').doc(sevaId);

  try {
    await db.runTransaction(async (transaction) => {
      const registrationDoc = await transaction.get(registrationRef);
      const sevaDoc = await transaction.get(sevaRef);
      if (!registrationDoc.exists || registrationDoc.data().status !== 'registered') {
        throw new Error('Active registration not found');
      }

      // Decrement count (never below zero) — skipped if the seva was deleted,
      // so the registration can still be cancelled.
      if (sevaDoc.exists && (sevaDoc.data().countRegistered || 0) > 0) {
        transaction.update(sevaRef, {
          countRegistered: admin.firestore.FieldValue.increment(-1)
        });
      }

      transaction.update(registrationRef, {
        status: 'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('failed-precondition', error.message);
  }
};

/**
 * Admin: View all registrations for a Seva
 */
exports.getSevaParticipants = async (data, context) => {
  await validateAdminOrHead(context);
  const { sevaId } = data;

  if (!sevaId) {
    throw new functions.https.HttpsError('invalid-argument', 'Seva ID is required');
  }

  const registrationsSnapshot = await db.collection('seva_registrations')
    .where('sevaId', '==', sevaId)
    .get();

  const participants = [];
  for (const doc of registrationsSnapshot.docs) {
    const regData = doc.data();
    // In a real app, join with user names
    participants.push({ id: doc.id, ...regData });
  }

  return { success: true, participants };
};

/**
 * Admin: Mark attendance (complete status)
 */
exports.markAttendance = async (data, context) => {
  await validateAdminOrHead(context);
  const { registrationId, status } = data || {}; // status usually 'completed'

  if (typeof registrationId !== 'string' || !registrationId || registrationId.includes('/') || !status) {
    throw new functions.https.HttpsError('invalid-argument', 'Registration ID and status are required');
  }
  if (!['completed', 'cancelled', 'registered'].includes(status)) {
    throw new functions.https.HttpsError('invalid-argument', 'Status must be completed, cancelled or registered');
  }

  const regRef = db.collection('seva_registrations').doc(registrationId);
  await db.runTransaction(async (t) => {
    const regDoc = await t.get(regRef);
    if (!regDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Registration not found');
    }
    const previous = regDoc.data().status;
    const sevaRef = db.collection('sevas').doc(String(regDoc.data().sevaId));
    const sevaDoc = await t.get(sevaRef);

    // Keep countRegistered in step when a seat is freed or re-taken.
    // "completed" still holds its seat, so only 'cancelled' frees one.
    const held = (s) => s === 'registered' || s === 'completed';
    if (sevaDoc.exists && held(previous) !== held(status)) {
      const count = sevaDoc.data().countRegistered || 0;
      if (!held(status) && count > 0) {
        t.update(sevaRef, { countRegistered: admin.firestore.FieldValue.increment(-1) });
      } else if (held(status)) {
        t.update(sevaRef, { countRegistered: admin.firestore.FieldValue.increment(1) });
      }
    }

    t.update(regRef, {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { success: true };
};

/**
 * Public/User: Get all Sevas
 */
exports.getSevas = async (data, context) => {
  await validateAuth(context);
  
  const snapshot = await db.collection('sevas').orderBy('date', 'asc').get();
  const sevas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  return { success: true, sevas };
};

/**
 * User: Get my joined Sevas
 */
exports.getMySevas = async (data, context) => {
  const userId = await validateAuth(context);

  const snapshot = await db.collection('seva_registrations')
    .where('userId', '==', userId)
    .get();

  const mySevas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  return { success: true, registrations: mySevas };
};
