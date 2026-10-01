const express = require('express');
const cors = require('cors');
const { admin, db, usePostgres } = require('./config/firebase');
const { sendTemplateMessage } = require('./services/notificationService');

// Import Handlers
// const authHandler = require('./handlers/authHandler'); // Auth triggers (onCreate) aren't handled by HTTP directly
const eventHandler = require('./handlers/eventHandler');
const attendanceHandler = require('./handlers/attendanceHandler');
const sadhanaHandler = require('./handlers/sadhanaHandler');
const accommodationHandler = require('./handlers/accommodationHandler');
const paymentHandler = require('./handlers/paymentHandler');
const sevaHandler = require('./handlers/sevaHandler');
const adminHandler = require('./handlers/adminHandler');
const otpHandler = require('./handlers/otpHandler');
const broadcastHandler = require('./handlers/broadcastHandler');
const uploadHandler = require('./handlers/uploadHandler');
const dataApi = require('./db/dataApi');
const migrate = require('./db/migrate');

// Defense-in-depth: log and keep running instead of letting one bad request
// (or a bug in any future handler) crash the whole process. Every route
// handler in this file already catches its own errors, but this is a
// last-resort net so a mistake here doesn't take down check-in, Sadhana
// logging, and every other feature along with payments.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

const app = express();

// Railway/Render put one proxy in front of the app. Trusting exactly one hop
// makes req.ip the real client address (used by the rate limiter below)
// without letting a client spoof it through its own X-Forwarded-For header.
app.set('trust proxy', 1);

// CORS: set ALLOWED_ORIGINS (comma-separated, e.g.
// "https://folkvizag.vercel.app,http://localhost:3001") to restrict which
// websites may call the API from a browser. When it is unset every origin is
// allowed, as before. The API authenticates with Bearer tokens rather than
// cookies, so an open CORS policy doesn't let other sites act as a signed-in
// user; the allowlist is extra hardening.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('ALLOWED_ORIGINS is not set; the API accepts browser requests from any origin.');
}
app.use(cors({
  origin: allowedOrigins.length
    // Requests without an Origin header (curl, Razorpay's webhook, health
    // checks) aren't browser cross-origin requests, so let them through.
    ? (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin))
    : '*',
}));
app.use(express.json({
  // Express defaults to 100kb, which is too tight for this app's writes: a
  // trip carries a long description, a day-by-day itinerary and inclusion
  // lists, and a rejected body surfaces as an opaque 413 rather than a
  // useful error. Images do NOT come through here at all - they go straight
  // from the browser to R2 via a presigned URL (see handlers/uploadHandler)
  // - so this only needs to be roomy for text.
  limit: '2mb',
  verify: (req, res, buf) => {
    // Preserve the RAW request body before parsing so webhook signature
    // verification (Razorpay) can HMAC the exact bytes that were sent.
    req.rawBody = buf;
  }
}));

// Small in-memory sliding-window rate limiter, keyed by client IP. It resets
// on restart and isn't shared across replicas, which is fine for one Railway
// instance. The OTP service also limits per phone number; this adds a per-IP
// cap so one client can't cycle through many numbers (which costs money per
// WhatsApp message) or spray guesses across them.
const rateBuckets = new Map();
const rateLimit = ({ name, windowMs, max }) => (req, res, next) => {
  const key = `${name}:${req.ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: { message: 'Too many requests. Please wait a few minutes and try again.', status: 'RESOURCE_EXHAUSTED' },
    });
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  next();
};
// Drop idle buckets so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    if (!hits.length || now - hits[hits.length - 1] > 60 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

// HttpsError codes the handlers throw, mapped to HTTP statuses. 'not-found'
// deliberately stays 500: the client reads a 404 as "backend is an outdated
// build without this route".
const HTTP_STATUS_BY_CODE = {
  'invalid-argument': 400,
  'failed-precondition': 400,
  'unauthenticated': 401,
  'permission-denied': 403,
  'already-exists': 409,
  'resource-exhausted': 429,
  'aborted': 409,
};

// On the first start with Postgres the data is copied over from Firestore
// before anything reads or writes it; requests wait for that (usually seconds).
let dbReadyError = null;
const dbReady = migrate.ensureMigrated()
  .then((r) => console.log('[db] ready', r.skipped ? `(${r.skipped})` : JSON.stringify(r.counts)))
  .catch((e) => { dbReadyError = e; console.error('[db] MIGRATION FAILED:', e); });
const waitForDb = async (req, res, next) => {
  await dbReady;
  if (dbReadyError) {
    return res.status(503).json({ error: { message: 'The database is being set up. Please try again in a minute.', status: 'UNAVAILABLE' } });
  }
  next();
};

// Helper to mimic Firebase Functions context
const createFirebaseContext = async (req) => {
  const context = { auth: null, rawRequest: req };
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      context.auth = decodedToken;
    } catch (error) {
      console.warn('Invalid Firebase token:', error.message);
    }
  }
  return context;
};

// Wrapper for functions mapped as 'onCall' logically
const handleOnCall = (handler) => {
  return async (req, res) => {
    try {
      const context = await createFirebaseContext(req);
      
      // onCall clients wrap data in `req.body.data`. req.body is undefined
      // when the request has no JSON body (Express 5), so guard it.
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const data = body.data !== undefined && body.data !== null ? body.data : body;

      const result = await handler(data, context);

      // Firebase onCall clients expect the result inside a "result" key natively
      res.status(200).json({ result });
    } catch (error) {
      console.error('Handler Error:', error);
      const httpStatus = HTTP_STATUS_BY_CODE[error.code] || 500;
      res.status(httpStatus).json({
        error: {
          message: error.message || 'Internal Server Error',
          status: httpStatus === 500 ? 'INTERNAL' : String(error.code).toUpperCase().replace(/-/g, '_'),
          // Firestore-style code ('not-found', 'aborted', ...) for the website's data layer.
          ...(typeof error.code === 'string' && /^[a-z-]+$/.test(error.code) ? { code: error.code } : {}),
        }
      });
    }
  };
};

console.log("Starting Express backend...");
app.use((req, res, next) => (req.method === 'POST' ? waitForDb(req, res, next) : next()));

// --- TESTS ---
app.all('/ping', (req, res) => {
  res.json({ result: { success: true, message: 'pong' } });
});

// Healthcheck (Railway healthcheck path)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: usePostgres ? 'postgres' : 'firestore', dbError: dbReadyError ? true : undefined });
});

// --- DATA (what the website used to read/write in Firestore directly) ---
app.post('/dbGet', rateLimit({ name: 'dbRead', windowMs: 15 * 60 * 1000, max: 6000 }), handleOnCall(dataApi.dbGet));
app.post('/dbQuery', rateLimit({ name: 'dbRead', windowMs: 15 * 60 * 1000, max: 6000 }), handleOnCall(dataApi.dbQuery));
app.post('/dbCommit', rateLimit({ name: 'dbWrite', windowMs: 15 * 60 * 1000, max: 1500 }), handleOnCall(dataApi.dbCommit));
app.post('/dbChanges', rateLimit({ name: 'dbChanges', windowMs: 15 * 60 * 1000, max: 4000 }), handleOnCall(dataApi.dbChanges));

// Admin: row counts per table, and re-copy from Firestore (mode 'delta' only
// fills rows untouched since the first copy; 'force' overwrites everything).
const requireAdmin = async (context) => {
  if (!context.auth) throw Object.assign(new Error('Please sign in first'), { code: 'unauthenticated' });
  const u = await db.collection('users').doc(context.auth.uid).get();
  if (!u.exists || u.data().role !== 'admin') throw Object.assign(new Error('Admins only'), { code: 'permission-denied' });
};
app.post('/dbStatus', handleOnCall(async (data, context) => {
  await requireAdmin(context);
  if (!usePostgres) return { backend: 'firestore' };
  const tables = await db.listCollections();
  const counts = {};
  for (const t of tables) counts[t.id] = (await db.collection(t.id).count().get()).data().count;
  const marker = await db.collection('system').doc('migration').get();
  return { backend: 'postgres', counts, migration: marker.exists ? marker.data() : null };
}));
app.post('/dbCopyFromFirestore', rateLimit({ name: 'dbCopy', windowMs: 60 * 60 * 1000, max: 5 }), handleOnCall(async (data, context) => {
  await requireAdmin(context);
  const mode = data && data.mode === 'force' ? 'force' : 'delta';
  return migrate.copyFirestoreToPostgres({ mode });
}));

// --- EVENTS ---
app.post('/createEvent', handleOnCall(eventHandler.createEvent));
app.post('/getEvents', handleOnCall(eventHandler.getEvents));

// --- ATTENDANCE ---
app.post('/verifyAttendance', handleOnCall(attendanceHandler.verifyAttendance));

// --- SADHANA ---
app.post('/submitSadhana', handleOnCall(sadhanaHandler.submitSadhana));
app.post('/getSadhanaMe', handleOnCall(sadhanaHandler.getSadhanaMe));
app.post('/getSadhanaAdmin', handleOnCall(sadhanaHandler.getSadhanaAdmin));

// --- ACCOMMODATION ---
app.post('/updateAccommodationStatus', handleOnCall(accommodationHandler.updateAccommodationStatus));

// --- SEVAS ---
app.post('/createSeva', handleOnCall(sevaHandler.createSeva));
app.post('/joinSeva', handleOnCall(sevaHandler.joinSeva));
app.post('/cancelSeva', handleOnCall(sevaHandler.cancelSeva));
app.post('/getSevas', handleOnCall(sevaHandler.getSevas));
app.post('/getMySevas', handleOnCall(sevaHandler.getMySevas));
app.post('/getSevaParticipants', handleOnCall(sevaHandler.getSevaParticipants));
app.post('/markSevaAttendance', handleOnCall(sevaHandler.markAttendance));

// --- PAYMENTS ---
// ---- Image uploads (Cloudflare R2, presigned straight from the browser) ----
app.post('/getUploadUrl', rateLimit({ name: 'uploads', windowMs: 15 * 60 * 1000, max: 300 }), handleOnCall(uploadHandler.getUploadUrl));
app.post('/deleteUpload', rateLimit({ name: 'uploads', windowMs: 15 * 60 * 1000, max: 300 }), handleOnCall(uploadHandler.deleteUpload));
app.post('/uploadConfig', handleOnCall(uploadHandler.uploadConfig));

app.post('/createOrder', handleOnCall(paymentHandler.createOrder));
app.post('/paymentConfig', handleOnCall(paymentHandler.paymentConfig));
app.post('/verifyPayment', rateLimit({ name: 'verifyPayment', windowMs: 15 * 60 * 1000, max: 60 }), handleOnCall(paymentHandler.verifyPayment));

// --- ADMIN SETUP (create or reset the shared `admin` login) ---
app.post('/createAdmin', rateLimit({ name: 'createAdmin', windowMs: 15 * 60 * 1000, max: 20 }), handleOnCall(adminHandler.createAdmin));

// --- OTP (Flaxxa WAPI WhatsApp login, no Firebase Blaze plan needed) ---
// Both are reachable by UNAUTHENTICATED callers (the user has no Firebase
// token yet) — that's the whole point of a login flow. Security lives in the
// service layer: phone format checks, resend/attempt rate limiting, 5-min TTL,
// single-use codes, and a server-only otp_codes collection.
// The per-IP caps are generous because a whole hall of people signing up at
// an event can share one Wi-Fi address; the per-phone limits do the fine work.
app.post('/sendOtp', rateLimit({ name: 'sendOtp', windowMs: 15 * 60 * 1000, max: 30 }), handleOnCall(otpHandler.sendOtp));
app.post('/verifyOtp', rateLimit({ name: 'verifyOtp', windowMs: 15 * 60 * 1000, max: 100 }), handleOnCall(otpHandler.verifyOtp));

// --- TEAM TOOLS ---
// WhatsApp template broadcast to a group of members (guides: own members only).
app.post('/broadcast', rateLimit({ name: 'broadcast', windowMs: 60 * 60 * 1000, max: 20 }), handleOnCall(broadcastHandler.broadcast));
// One-off maintenance: index every profile's phone for fast OTP login lookups.
app.post('/backfillPhoneIndex', rateLimit({ name: 'backfill', windowMs: 60 * 60 * 1000, max: 5 }), handleOnCall(broadcastHandler.backfillPhoneIndex));

// Raw HTTP handlers (like webhooks)
app.post('/razorpayWebhook', (req, res) => paymentHandler.razorpayWebhook(req, res));

// --- NOTIFICATIONS (admin-triggered WhatsApp template broadcast) ---
// POST /notify  { phone, templateId, params[] }  — sends one template message
app.post('/notify', async (req, res) => {
  try {
    const context = await createFirebaseContext(req);
    if (!context.auth) {
      return res.status(401).json({ error: { message: 'Unauthenticated' } });
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ error: { message: 'Admins only' } });
    }

    const { phone, templateId, params } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: { message: 'phone is required' } });
    }

    const success = await sendTemplateMessage(phone, templateId, params || []);
    res.status(200).json({ result: { success } });
  } catch (error) {
    console.error('Notify error:', error);
    res.status(500).json({ error: { message: error.message || 'Internal Server Error' } });
  }
});

// Healthcheck route exactly what Render expects
app.get('/', (req, res) => {
  res.send('Folkvizag Backend is running!');
});

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server actively listening on port ${PORT} for Railway`);
  // One-time (per version) phone index build, in the background.
  dbReady.then(() => broadcastHandler.ensurePhoneIndex())
    .then((r) => console.log('[phone-index]', r.skipped ? 'already built' : `built: ${r.updated} of ${r.scanned} profiles updated`))
    .catch((e) => console.error('[phone-index] build failed:', e.message));
});
