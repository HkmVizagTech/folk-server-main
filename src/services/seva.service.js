'use strict';

const { db, admin } = require('../config/firebase');
const { HttpsError } = require('../utils/errors');
const log = require('../utils/logger').create('seva');

const ts = () => admin.firestore.FieldValue.serverTimestamp();
const inc = (n) => admin.firestore.FieldValue.increment(n);

// Seva transactions throw plain Errors with user-facing messages; the client
// sees them as 'failed-precondition'.
const asPrecondition = (error) => new HttpsError('failed-precondition', error.message);

const create = async (user, fields) => {
  const { title, description, sevaType, date, time, location, maxVolunteers, isRecurring } = fields;

  if (!title || !description || !sevaType || !date || !time || !location || !maxVolunteers) {
    throw new HttpsError('invalid-argument', 'Missing required Seva fields');
  }
  const volunteers = parseInt(maxVolunteers, 10);
  if (!Number.isInteger(volunteers) || volunteers < 1 || volunteers > 10000) {
    throw new HttpsError('invalid-argument', 'maxVolunteers must be a whole number of at least 1');
  }

  const sevaRef = db.collection('sevas').doc();
  await sevaRef.set({
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
    createdAt: ts(),
  });

  log.info(`Seva ${sevaRef.id} created.`);
  return { success: true, sevaId: sevaRef.id };
};

const join = async (userId, sevaId) => {
  if (!sevaId) throw new HttpsError('invalid-argument', 'Seva ID is required');

  const sevaRef = db.collection('sevas').doc(sevaId);
  const registrationRef = db.collection('seva_registrations').doc(`${userId}_${sevaId}`);

  try {
    await db.runTransaction(async (transaction) => {
      const sevaDoc = await transaction.get(sevaRef);
      const registrationDoc = await transaction.get(registrationRef);

      if (!sevaDoc.exists) throw new Error('Seva does not exist');
      if (registrationDoc.exists && registrationDoc.data().status === 'registered') {
        throw new Error('You are already registered for this Seva');
      }
      // Re-joining would overwrite the staff-confirmed "completed" record.
      if (registrationDoc.exists && registrationDoc.data().status === 'completed') {
        throw new Error('You have already completed this Seva');
      }
      const sevaData = sevaDoc.data();
      if (sevaData.countRegistered >= sevaData.maxVolunteers) throw new Error('Seva is already full');

      transaction.update(sevaRef, { countRegistered: inc(1) });
      transaction.set(registrationRef, {
        userId, sevaId, status: 'registered', createdAt: ts(), updatedAt: ts(),
      });
    });
    return { success: true };
  } catch (error) {
    throw asPrecondition(error);
  }
};

const cancel = async (userId, sevaId) => {
  if (!sevaId || sevaId.includes('/')) throw new HttpsError('invalid-argument', 'Seva ID is required');

  const registrationRef = db.collection('seva_registrations').doc(`${userId}_${sevaId}`);
  const sevaRef = db.collection('sevas').doc(sevaId);

  try {
    await db.runTransaction(async (transaction) => {
      const registrationDoc = await transaction.get(registrationRef);
      const sevaDoc = await transaction.get(sevaRef);
      if (!registrationDoc.exists || registrationDoc.data().status !== 'registered') {
        throw new Error('Active registration not found');
      }

      // Decrement count (never below zero), skipped if the seva was deleted so
      // the registration can still be cancelled.
      if (sevaDoc.exists && (sevaDoc.data().countRegistered || 0) > 0) {
        transaction.update(sevaRef, { countRegistered: inc(-1) });
      }
      transaction.update(registrationRef, { status: 'cancelled', updatedAt: ts() });
    });
    return { success: true };
  } catch (error) {
    throw asPrecondition(error);
  }
};

const listParticipants = async (sevaId) => {
  if (!sevaId) throw new HttpsError('invalid-argument', 'Seva ID is required');
  const snap = await db.collection('seva_registrations').where('sevaId', '==', sevaId).get();
  return { success: true, participants: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
};

const markAttendance = async (registrationId, status) => {
  if (typeof registrationId !== 'string' || !registrationId || registrationId.includes('/') || !status) {
    throw new HttpsError('invalid-argument', 'Registration ID and status are required');
  }
  if (!['completed', 'cancelled', 'registered'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Status must be completed, cancelled or registered');
  }

  const regRef = db.collection('seva_registrations').doc(registrationId);
  await db.runTransaction(async (t) => {
    const regDoc = await t.get(regRef);
    if (!regDoc.exists) throw new HttpsError('not-found', 'Registration not found');
    const previous = regDoc.data().status;
    const sevaRef = db.collection('sevas').doc(String(regDoc.data().sevaId));
    const sevaDoc = await t.get(sevaRef);

    // Keep countRegistered in step when a seat is freed or re-taken.
    // "completed" still holds its seat, so only 'cancelled' frees one.
    const held = (s) => s === 'registered' || s === 'completed';
    if (sevaDoc.exists && held(previous) !== held(status)) {
      const count = sevaDoc.data().countRegistered || 0;
      if (!held(status) && count > 0) t.update(sevaRef, { countRegistered: inc(-1) });
      else if (held(status)) t.update(sevaRef, { countRegistered: inc(1) });
    }

    t.update(regRef, { status, updatedAt: ts() });
  });
  return { success: true };
};

const listAll = async () => {
  const snapshot = await db.collection('sevas').orderBy('date', 'asc').get();
  return { success: true, sevas: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
};

const listForUser = async (userId) => {
  const snapshot = await db.collection('seva_registrations').where('userId', '==', userId).get();
  return { success: true, registrations: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
};

module.exports = { create, join, cancel, listParticipants, markAttendance, listAll, listForUser };
