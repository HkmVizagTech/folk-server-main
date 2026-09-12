const admin = require('firebase-admin');
const fs = require('fs');

// Load credentials in order of preference:
// 1. SERVICE_ACCOUNT_KEY (inline JSON string)
// 2. GOOGLE_APPLICATION_CREDENTIALS (path to a JSON key file)
// 3. /etc/secrets/serviceAccountKey.json (Cloud Run / Railway mounts)
// 4. Application Default Credentials (local emulator / gcloud auth)
let credential;
const inlineKey = process.env.SERVICE_ACCOUNT_KEY;
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const defaultPath = '/etc/secrets/serviceAccountKey.json';

if (inlineKey) {
  try {
    credential = admin.credential.cert(JSON.parse(inlineKey));
  } catch (error) {
    console.error('Failed to parse SERVICE_ACCOUNT_KEY env var:', error.message);
  }
} else if (credPath && fs.existsSync(credPath)) {
  credential = admin.credential.cert(require(credPath));
} else if (fs.existsSync(defaultPath)) {
  credential = admin.credential.cert(require(defaultPath));
} else {
  console.warn(
    'No service account key found (SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS / /etc/secrets). Falling back to Application Default Credentials.'
  );
}

admin.initializeApp({
  credential: credential || admin.credential.applicationDefault(),
});

const db = admin.firestore();

module.exports = { admin, db };