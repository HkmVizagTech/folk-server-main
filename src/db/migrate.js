/**
 * One-time move of every Firestore collection into Postgres.
 *
 * On the first start with DATABASE_URL set, the server:
 *   1. makes Firestore read/write-locked for browsers (so an old cached copy
 *      of the website can't keep writing to the old database),
 *   2. copies every document, keeping ids and timestamps,
 *   3. records system/migration in Postgres so it never runs twice.
 *
 * Rows go into the typed tables (src/db/schema) through db.importDocuments.
 * Copied rows get version 0; a later copy (mode 'delta') only refreshes rows
 * still at version 0, so nothing changed in Postgres since is overwritten.
 * mode 'force' overwrites everything.
 */
const env = require('../config/env');
const { admin, firestore, db, usePostgres } = require('../config/firebase');
const { toJson, NAME_RE } = require('./pgstore');

const LOCKED_RULES = `rules_version = '2';
// FOLK Vizag moved to Postgres. The website talks to the FOLK server, which
// uses the Admin SDK; browsers must not read or write Firestore any more.
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

const lockFirestore = async () => {
  try {
    await admin.securityRules().releaseFirestoreRulesetFromSource(LOCKED_RULES);
    console.log('[migrate] Firestore locked for browsers.');
    return true;
  } catch (e) {
    console.warn('[migrate] Could not lock Firestore rules:', e.message);
    return false;
  }
};

const copyCollection = async (name, mode, anomalies) => {
  // 'delta' only refreshes rows still at version 0 (untouched since the first
  // copy); 'force' overwrites everything. Copied rows get version 0.
  const importMode = mode === 'force' ? 'overwrite' : 'guard0';
  let copied = 0;
  let last = null;
  for (;;) {
    let q = firestore.collection(name).orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    const docs = snap.docs.map((d) => ({
      id: d.id,
      data: toJson(d.data()) || {},
      version: 0,
      createdAt: d.createTime ? d.createTime.toDate().toISOString() : new Date().toISOString(),
      updatedAt: d.updateTime ? d.updateTime.toDate().toISOString() : new Date().toISOString(),
    }));
    // Typed tables: values that don't fit a column are kept in `extra`; clashes
    // and unplaceable documents are reported (and parked in migration_rejects).
    const report = await db.importDocuments(name, docs, { mode: importMode, migration: 'firestore-copy' });
    copied += report.inserted;
    for (const k of ['demoted', 'diverted']) {
      for (const [key, n] of Object.entries(report[k])) anomalies[`${k}:${key}`] = (anomalies[`${k}:${key}`] || 0) + n;
    }
    if (report.rejected) anomalies[`rejected:${name}`] = (anomalies[`rejected:${name}`] || 0) + report.rejected;
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  return copied;
};

const copyFirestoreToPostgres = async ({ mode = 'delta' } = {}) => {
  if (!usePostgres) throw new Error('DATABASE_URL is not set; nothing to copy into.');
  const started = Date.now();
  const collections = (await firestore.listCollections()).map((c) => c.id).filter((n) => NAME_RE.test(n));
  const counts = {};
  const anomalies = {};
  for (const name of collections) {
    counts[name] = await copyCollection(name, mode, anomalies);
    console.log(`[migrate] ${name}: ${counts[name]} rows`);
  }
  if (Object.keys(anomalies).length) console.warn('[migrate] anomalies:', JSON.stringify(anomalies));
  return { counts, collections, anomalies, ms: Date.now() - started };
};

const MARKER = () => db.collection('system').doc('migration');

/** Runs once, on the first start with Postgres. Resolves when data is ready. */
const ensureMigrated = async () => {
  if (!usePostgres) return { skipped: 'firestore' };
  const marker = await MARKER().get();
  if (marker.exists && marker.data().completedAt) return { skipped: 'already-migrated' };
  console.log('[migrate] First start on Postgres: copying data from Firestore…');
  const locked = await lockFirestore();
  const result = await copyFirestoreToPostgres({ mode: 'delta' });
  await MARKER().set({
    source: 'firestore',
    projectId: env.firebase.projectId || (admin.app().options.credential && admin.app().options.projectId) || null,
    counts: result.counts,
    firestoreLocked: locked,
    durationMs: result.ms,
    completedAt: new Date().toISOString(),
  });
  console.log(`[migrate] Done in ${result.ms} ms.`);
  return result;
};

module.exports = { ensureMigrated, copyFirestoreToPostgres, lockFirestore, LOCKED_RULES };
