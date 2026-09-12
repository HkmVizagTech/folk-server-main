const { db, admin } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const functions = require('firebase-functions');

exports.submitSadhana = async (data, context) => {
  const uid = await validateAuth(context);
  const { rounds, date } = data; // expected YYYY-MM-DD
  const TARGET = 16;
  
  if (rounds === undefined || rounds < 0 || rounds > 64) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid rounds submitted. Must be between 0 and 64.');
  }

  // Handle timezone/date validation (simplified to system date comparison)
  const today = new Date();
  const todayString = today.toISOString().split('T')[0];
  
  if (date !== todayString) {
    throw new functions.https.HttpsError('invalid-argument', 'Sadhana entries must be recorded for today only.');
  }

  const docId = `${uid}_${date}`;
  const sadhanaRef = db.collection("sadhana_logs").doc(docId);
  const existing = await sadhanaRef.get();

  if (existing.exists) {
    throw new functions.https.HttpsError("already-exists", "Sadhana already submitted for today");
  }

  const userRef = db.collection("users").doc(uid);
  
  return await db.runTransaction(async (t) => {
    const userDoc = await t.get(userRef);
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User profile not found');
    }
    const userData = userDoc.data();
    
    // Streak Logic
    let currentStreak = 0;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayString = yesterday.toISOString().split('T')[0];

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
