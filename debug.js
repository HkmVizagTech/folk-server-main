const { db } = require('./config/firebase');

async function debug() {
  try {
    const sevas = await db.collection('sevas').limit(1).get();
    console.log("Sevas collection check - found docs:", sevas.size);
    if (sevas.size > 0) {
        console.log("First seva:", sevas.docs[0].data());
    }
  } catch (error) {
    console.error("Debug error:", error);
  }
}

debug();
