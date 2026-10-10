'use strict';

const { db, admin } = require('../config/firebase');
const { HttpsError } = require('../utils/errors');

const TARGET = 16;
const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar date (YYYY-MM-DD) in India. The server runs in UTC, so using
// toISOString() rejected every entry made between midnight and 05:30 IST as
// "not today".
const TIME_ZONE = 'Asia/Kolkata';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateInIndia = (d) => dateFormat.format(d);

// Streak continues only from yesterday's completed target; a short day resets it.
const nextStreak = (rounds, userData, yesterday) => {
  if (rounds < TARGET) return 0;
  return userData.lastSadhanaDate === yesterday && (userData.streak || 0) > 0 ? (userData.streak || 0) + 1 : 1;
};

const scoreFor = (rounds, streak) => {
  if (rounds < TARGET) return 0;
  let score = 10; // Base completion bonus
  if (rounds > TARGET) score += (rounds - TARGET) * 2; // Extra rounds bonus
  if (streak === 3) score += 20;
  if (streak === 7) score += 50;
  return score;
};

/** Record today's sadhana and update the devotee's streak and score atomically. */
const submitToday = async (uid, rounds, date) => {
  // Must be a real whole number: a string like "20" or NaN used to pass the range check.
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 64) {
    throw new HttpsError('invalid-argument', 'Invalid rounds submitted. Must be a whole number between 0 and 64.');
  }

  const now = new Date();
  if (date !== dateInIndia(now)) {
    throw new HttpsError('invalid-argument', 'Sadhana entries must be recorded for today only.');
  }

  const sadhanaRef = db.collection('sadhana_logs').doc(`${uid}_${date}`);
  const userRef = db.collection('users').doc(uid);

  return db.runTransaction(async (t) => {
    // The duplicate check lives inside the transaction, so two quick
    // submissions can't both pass it and double the score.
    const existing = await t.get(sadhanaRef);
    if (existing.exists) {
      throw new HttpsError('already-exists', 'Sadhana already submitted for today');
    }
    const userDoc = await t.get(userRef);
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User profile not found');
    }
    const userData = userDoc.data();

    const streak = nextStreak(rounds, userData, dateInIndia(new Date(now.getTime() - DAY_MS)));
    const score = scoreFor(rounds, streak);

    t.set(sadhanaRef, {
      userId: uid,
      userName: userData.name || 'Devotee',
      date,
      roundsCompleted: rounds,
      target: TARGET,
      progressPercentage: Math.min(100, Math.round((rounds / TARGET) * 100)),
      streak,
      score,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.update(userRef, {
      streak,
      score: (userData.score || 0) + score,
      lastSadhanaDate: date,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, score, streak };
  });
};

/** Profile summary plus the last 7 logs in chronological order. */
const getMine = async (uid) => {
  const [userDoc, logsSnapshot] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('sadhana_logs').where('userId', '==', uid).orderBy('date', 'desc').limit(7).get(),
  ]);
  const userData = userDoc.data() || {};
  const logs = logsSnapshot.docs.map((doc) => doc.data());

  return {
    profile: { streak: userData.streak || 0, score: userData.score || 0, totalLogs: logs.length },
    logs: logs.reverse(), // chronological for charts
  };
};

/** Leaderboard rows for every devotee. */
const listDevotees = async () => {
  const usersSnapshot = await db.collection('users').where('role', '==', 'devotee').get();
  return usersSnapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      uid: d.uid,
      name: d.name,
      streak: d.streak || 0,
      score: d.score || 0,
      lastSadhanaDate: d.lastSadhanaDate || 'None',
    };
  });
};

module.exports = { submitToday, getMine, listDevotees };
