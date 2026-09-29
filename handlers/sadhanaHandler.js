const { db, admin } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const functions = require('firebase-functions');

// Calendar date (YYYY-MM-DD) in India. The server runs in UTC, so using
// toISOString() rejected every entry made between midnight and 05:30 IST as
// "not today".
const TIME_ZONE = 'Asia/Kolkata';
const dateInIndia = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

exports.submitSadhana = async (data, context) => {
  const uid = await validateAuth(context);
  const { rounds, date } = data || {}; // expected YYYY-MM-DD
  const TARGET = 16;

  // Must be a real whole number: a string like "20" or NaN used to pass the
  // range check and get stored as-is.
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 64) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid rounds submitted. Must be a whole number between 0 and 64.');
  }

  const now = new Date();
  const todayString = dateInIndia(now);

  if (date !== todayString) {
    throw new functions.https.HttpsError('invalid-argument', 'Sadhana entries must be recorded for today only.');
  }

  const docId = `${uid}_${date}`;
  const sadhanaRef = db.collection("sadhana_logs").doc(docId);
  const userRef = db.collection("users").doc(uid);

  return await db.runTransaction(async (t) => {
    // The duplicate check lives inside the transaction, so two quick
    // submissions can't both pass it and double the score.
    const existing = await t.get(sadhanaRef);
    if (existing.exists) {
      throw new functions.https.HttpsError("already-exists", "Sadhana already submitted for today");
    }

    const userDoc = await t.get(userRef);
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User profile not found');
    }
    const userData = userDoc.data();

    // Streak Logic
    let currentStreak = 0;
    const yesterdayString = dateInIndia(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    if (rounds >= TARGET) {
      if (userData.lastSadhanaDate === yesterdayString && (userData.streak || 0) > 0) {
        currentStreak = (userData.streak || 0) + 1;
      } else {
        currentStreak = 1;
      }
    } else {
      currentStreak = 0;
    }

    // Score Calculation
    let logScore = 0;
    if (rounds >= TARGET) {
      logScore += 10; // Base completion bonus
      const extraRounds = rounds - TARGET;
      if (extraRounds > 0) {
        logScore += extraRounds * 2; // Extra rounds bonus
      }

      // Streak Bonuses
      if (currentStreak === 3) logScore += 20;
      if (currentStreak === 7) logScore += 50;
    }

    const progress = Math.min(100, Math.round((rounds / TARGET) * 100));

    const entryData = {
      userId: uid,
      userName: userData.name || 'Devotee',
      date,
      roundsCompleted: rounds,
      target: TARGET,
      progressPercentage: progress,
      streak: currentStreak,
      score: logScore,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    t.set(sadhanaRef, entryData);
    
    t.update(userRef, {
      streak: currentStreak,
      score: (userData.score || 0) + logScore,
      lastSadhanaDate: date,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, score: logScore, streak: currentStreak };
  });
};

exports.getSadhanaMe = async (data, context) => {
  const uid = await validateAuth(context);
  
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data() || {};

  // Fetch last 7 days of logs
  const logsSnapshot = await db.collection("sadhana_logs")
    .where("userId", "==", uid)
    .orderBy("date", "desc")
    .limit(7)
    .get();

  const logs = [];
  logsSnapshot.forEach(doc => logs.push(doc.data()));

  return {
    profile: {
      streak: userData.streak || 0,
      score: userData.score || 0,
      totalLogs: logs.length
    },
    logs: logs.reverse() // Sort back to chronological for charts
  };
};

exports.getSadhanaAdmin = async (data, context) => {
  const uid = await validateAuth(context);
  
  // Basic Admin Check
  const callerDoc = await db.collection("users").doc(uid).get();
  if (callerDoc.data()?.role !== 'admin' && callerDoc.data()?.role !== 'folks_head') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const usersSnapshot = await db.collection("users")
    .where("role", "==", "devotee")
    .get();

  const devotees = [];
  usersSnapshot.forEach(doc => {
    const d = doc.data();
    devotees.push({
      uid: d.uid,
      name: d.name,
      streak: d.streak || 0,
      score: d.score || 0,
      lastSadhanaDate: d.lastSadhanaDate || 'None'
    });
  });

  return { devotees };
};
