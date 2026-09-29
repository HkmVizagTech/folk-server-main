/**
 * One-time move of every Firestore collection into Postgres.
 *
 * On the first start with DATABASE_URL set, the server:
 *   1. makes Firestore read/write-locked for browsers (so an old cached copy
 *      of the website can't keep writing to the old database),
 *   2. copies every document, keeping ids and timestamps,
 *   3. records system/migration in Postgres so it never runs twice.
 *
 * Copied rows get version 0; a later copy (mode 'delta') only refreshes rows
 * still at version 0, so nothing changed in Postgres since is overwritten.
 * mode 'force' overwrites everything.
 */
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

const copyCollection = async (name, mode) => {
  const table = `"${name}"`;
  await db._ensure(name);
  let copied = 0;
  let last = null;
  for (;;) {
    let q = firestore.collection(name).orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    const ids = [];
    const datas = [];
    const created = [];
    const updated = [];
    for (const d of snap.docs) {
      ids.push(d.id);
      datas.push(JSON.stringify(toJson(d.data()) || {}));
      created.push(d.createTime ? d.createTime.toDate().toISOString() : new Date().toISOString());
      updated.push(d.updateTime ? d.updateTime.toDate().toISOString() : new Date().toISOString());
    }
    const guard = mode === 'force' ? '' : `WHERE ${table}.version = 0`;
    const res = await db.pool.query(
      `INSERT INTO ${table} (id, data, version, created_at, updated_at)
       SELECT * FROM unnest($1::text[], $2::jsonb[], array_fill(0::bigint, ARRAY[cardinality($1::text[])]), $3::timestamptz[], $4::timestamptz[])
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = 0,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
       ${guard}`,
      [ids, datas, created, updated]);
    copied += res.rowCount;
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
  for (const name of collections) {
    counts[name] = await copyCollection(name, mode);
    console.log(`[migrate] ${name}: ${counts[name]} rows`);
  }
  return { counts, collections, ms: Date.now() - started };
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
    projectId: process.env.GCLOUD_PROJECT || (admin.app().options.credential && admin.app().options.projectId) || null,
    counts: result.counts,
    firestoreLocked: locked,
    durationMs: result.ms,
    completedAt: new Date().toISOString(),
  });
  console.log(`[migrate] Done in ${result.ms} ms.`);
  return result;
};

module.exports = { ensureMigrated, copyFirestoreToPostgres, lockFirestore, LOCKED_RULES };
