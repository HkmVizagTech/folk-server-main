const { db, admin } = require('../config/firebase');

exports.onUserCreate = async (user) => {
  const { uid, email, phoneNumber, displayName } = user;
  
  // Create user profile in Firestore whenever a new Firebase Auth user signs up
  return db.collection("users").doc(uid).set({
    uid,
    email: email || "",
    phone: phoneNumber || "",
    name: displayName || "Devotee",
    role: "devotee", // Default role
    streak: 0,
    score: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    metadata: {
      location: "Vizag",
      source: "folk_vizag"
    }
  });
};
