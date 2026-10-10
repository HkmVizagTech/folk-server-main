'use strict';

/** The one-time Firestore -> Postgres copy, against a fake Firestore, landing in the typed tables. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/db');

let dbh;
let fb;
let migrateMod;
const calls = [];

const FS = {
  users: {
    uid1: { name: 'From Firestore', role: 'devotee', streak: 3, createdAt: 'TS:2026-02-03T04:05:06.007Z', dob: '2000-01-01', qrToken: 'QR1' },
    uid2: { name: 'Second', role: 'folks_head', qrToken: 'QR1', guideId: null }, // duplicate qrToken
  },
  trips: {
    t1: { slug: 'yatra', title: 'Yatra', price: 49, gallery: ['a'], startDate: '2026-10-10', itinerary: [{ day: 1 }], createdAt: 'TS:2026-01-01T00:00:00.000Z' },
  },
  mystery: { m1: { anything: { goes: [1, 2] } } },
};

const fakeFirestore = (admin) => {
  const mkTs = (iso) => admin.firestore.Timestamp.fromDate(new Date(iso));
  const revive = (v) => (typeof v === 'string' && v.startsWith('TS:') ? mkTs(v.slice(3)) : v);
  const docOf = (id, data) => ({
    id,
    data: () => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, revive(v)])),
    createTime: mkTs('2025-01-01T00:00:00.000Z'),
    updateTime: mkTs('2025-06-01T00:00:00.000Z'),
  });
  return {
    listCollections: async () => Object.keys(FS).map((id) => ({ id })),
    collection: (name) => {
      const state = { after: null };
      const q = {
        orderBy: () => q,
        limit: () => q,
        startAfter: (d) => { state.after = d.id; return q; },
        get: async () => {
          const ids = Object.keys(FS[name]).sort().filter((i) => state.after === null || i > state.after);
          const docs = ids.map((i) => docOf(i, FS[name][i]));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      };
      return q;
    },
  };
};

before(async () => {
  dbh = await createDatabase();
  process.env.DATABASE_URL = dbh.url;
  delete process.env.DATA_BACKEND;
  const admin = require('firebase-admin');
  fb = require('../src/config/firebase');
  const fake = fakeFirestore(admin);
  fb.firestore.listCollections = fake.listCollections;
  fb.firestore.collection = fake.collection;
  Object.defineProperty(admin, 'securityRules', { configurable: true, value: () => ({ releaseFirestoreRulesetFromSource: async (src) => { calls.push(src); } }) });
  const { migrate } = require('../src/db/migrator');
  await migrate(fb.db.pool, { log: { info() {}, warn() {}, error() {} } });
  migrateMod = require('../src/db/migrate');
});
after(async () => { await fb.db.close(); await dbh.drop(); });

test('first start copies every collection into typed tables, locks Firestore, writes the marker, never runs twice', async () => {
  const r = await migrateMod.ensureMigrated();
  assert.deepEqual(r.counts, { users: 2, trips: 1, mystery: 1 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /allow read, write: if false/);
  const u = await fb.db.pool.query("SELECT name, streak, qr_token, dob, doc_created_at, version, created_at, updated_at, extra FROM users ORDER BY id");
  assert.equal(u.rows[0].streak, 3);
  assert.equal(u.rows[0].qr_token, 'QR1');
  assert.equal(u.rows[0].dob, '2000-01-01');
  assert.equal(u.rows[0].doc_created_at.toISOString(), '2026-02-03T04:05:06.007Z');
  assert.equal(Number(u.rows[0].version), 0);
  assert.equal(u.rows[0].created_at.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(u.rows[0].updated_at.toISOString(), '2025-06-01T00:00:00.000Z');
  assert.equal(u.rows[1].qr_token, null); // duplicate qrToken kept the document, key moved to extra
  assert.equal(u.rows[1].extra.qrToken, 'QR1');
  assert.deepEqual(r.anomalies, { 'demoted:users.qr_token': 1 });
  const t = (await fb.db.collection('trips').doc('t1').get()).data();
  assert.equal(t.price, 49);
  assert.equal(String(t.createdAt), '2026-01-01T00:00:00.000Z');
  assert.deepEqual((await fb.db.collection('mystery').doc('m1').get()).data(), { anything: { goes: [1, 2] } });
  const marker = (await fb.db.collection('system').doc('migration').get()).data();
  assert.equal(marker.source, 'firestore');
  assert.deepEqual(marker.counts, { users: 2, trips: 1, mystery: 1 });
  assert.equal(marker.firestoreLocked, true);
  assert.deepEqual(await migrateMod.ensureMigrated(), { skipped: 'already-migrated' });
  assert.equal(calls.length, 1);
});

test('delta copy refreshes only rows still at version 0; force overwrites everything', async () => {
  await fb.db.collection('users').doc('uid1').update({ name: 'Edited in Postgres' }); // version 1: hands off
  FS.users.uid2.name = 'Second (changed in Firestore)';
  FS.users.uid1.name = 'From Firestore (changed)';
  await migrateMod.copyFirestoreToPostgres({ mode: 'delta' });
  assert.equal((await fb.db.collection('users').doc('uid1').get()).data().name, 'Edited in Postgres');
  assert.equal((await fb.db.collection('users').doc('uid2').get()).data().name, 'Second (changed in Firestore)');
  await migrateMod.copyFirestoreToPostgres({ mode: 'force' });
  assert.equal((await fb.db.collection('users').doc('uid1').get()).data().name, 'From Firestore (changed)');
});
