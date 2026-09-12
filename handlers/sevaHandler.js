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

  const sevaId = db.collection("sevas").doc().id;
  
  const sevaData = {
    title,
    description,
    sevaType,
    date,
    time,
    location,
    maxVolunteers: parseInt(maxVolunteers),
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
  const { sevaId } = data;

  const registrationId = `${userId}_${sevaId}`;
  const registrationRef = db.collection('seva_registrations').doc(registrationId);
  const sevaRef = db.collection('sevas').doc(sevaId);

  try {
    await db.runTransaction(async (transaction) => {
      const registrationDoc = await transaction.get(registrationRef);
      if (!registrationDoc.exists || registrationDoc.data().status !== 'registered') {
        throw new Error('Active registration not found');
      }

      // Decrement count and update status
      transaction.update(sevaRef, {
        countRegistered: admin.firestore.FieldValue.increment(-1)
      });

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
  const { registrationId, status } = data; // status usually 'completed'

  if (!registrationId || !status) {
    throw new functions.https.HttpsError('invalid-argument', 'Registration ID and status are required');
  }

  await db.collection('seva_registrations').doc(registrationId).update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
