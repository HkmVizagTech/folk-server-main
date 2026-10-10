'use strict';

const { db, usePostgres } = require('../config/firebase');
const migrate = require('../db/migrate');
const dataApi = require('../db/dataApi');
const { HttpsError } = require('../utils/errors');

// What the website used to read/write in Firestore directly.
exports.dbGet = dataApi.dbGet;
exports.dbQuery = dataApi.dbQuery;
exports.dbCommit = dataApi.dbCommit;
exports.dbChanges = dataApi.dbChanges;

// Admin guard for the maintenance endpoints below.
const requireAdmin = async (context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Please sign in first');
  const u = await db.collection('users').doc(context.auth.uid).get();
  if (!u.exists || u.data().role !== 'admin') throw new HttpsError('permission-denied', 'Admins only');
};

// POST /dbStatus: row counts per table plus the migration marker.
exports.dbStatus = async (data, context) => {
  await requireAdmin(context);
  if (!usePostgres) return { backend: 'firestore' };
  const tables = await db.listCollections();
  // Independent COUNT queries: run them together instead of one by one.
  const entries = await Promise.all(
    tables.map(async (t) => [t.id, (await db.collection(t.id).count().get()).data().count])
  );
  const marker = await db.collection('system').doc('migration').get();
  return { backend: 'postgres', counts: Object.fromEntries(entries), migration: marker.exists ? marker.data() : null };
};

// POST /dbCopyFromFirestore { mode: 'delta' | 'force' }: 'delta' only fills
// rows untouched since the first copy; 'force' overwrites everything.
exports.dbCopyFromFirestore = async (data, context) => {
  await requireAdmin(context);
  const mode = data && data.mode === 'force' ? 'force' : 'delta';
  return migrate.copyFirestoreToPostgres({ mode });
};
