const admin = require('firebase-admin');
const fs = require('fs');
const env = require('./env');
const log = require('../utils/logger').create('firebase');

// Load credentials in order of preference:
// 1. SERVICE_ACCOUNT_KEY (inline JSON string)
// 2. GOOGLE_APPLICATION_CREDENTIALS (path to a JSON key file)
// 3. /etc/secrets/serviceAccountKey.json (Cloud Run / Railway mounts)
// 4. Application Default Credentials (local emulator / gcloud auth)
let credential;
const inlineKey = env.firebase.serviceAccountKey;
const credPath = env.firebase.credentialsPath;
const defaultPath = env.firebase.defaultCredentialsPath;

if (inlineKey) {
  try {
    credential = admin.credential.cert(JSON.parse(inlineKey));
  } catch (error) {
    log.error('Failed to parse SERVICE_ACCOUNT_KEY env var:', error.message);
  }
} else if (credPath && fs.existsSync(credPath)) {
  credential = admin.credential.cert(require(credPath));
} else if (fs.existsSync(defaultPath)) {
  credential = admin.credential.cert(require(defaultPath));
} else {
  log.warn(
    'No service account key found (SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS / /etc/secrets). Falling back to Application Default Credentials.'
  );
}

// Sign-in tokens can be verified with just the project id, so a developer
// without a key file can still run the server locally. Anything that needs
// real Google credentials (Firestore copy, listing accounts) logs and carries on.
const DEFAULT_PROJECT_ID = 'folkvizag-b6830';
admin.initializeApp({
  credential: credential || admin.credential.applicationDefault(),
  projectId: env.firebase.projectId || DEFAULT_PROJECT_ID,
});

// The Firestore database (kept for the one-time copy into Postgres and as a
// fallback). The app itself uses `db`: Postgres whenever DATABASE_URL is set
// (unless DATA_BACKEND=firestore), with the same API as Firestore.
const firestore = admin.firestore();
const usePostgres = env.database.usePostgres;
let db = firestore;
if (usePostgres) {
  const { PgStore } = require('../db/pgstore');
  db = new PgStore(env.database.url, { max: env.database.poolMax });
}
log.info(`Using ${usePostgres ? 'Postgres' : 'Firestore'}`);

module.exports = { admin, db, firestore, usePostgres };