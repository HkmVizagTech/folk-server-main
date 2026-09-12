const functions = require('firebase-functions');
console.log("BACKEND: Firebase Functions Initializing...");

// Import Handlers
// (These will be uncommented as we build them)
const authHandler = require('./handlers/authHandler');
const eventHandler = require('./handlers/eventHandler');
const attendanceHandler = require('./handlers/attendanceHandler');
const sadhanaHandler = require('./handlers/sadhanaHandler');
const accommodationHandler = require('./handlers/accommodationHandler');
const paymentHandler = require('./handlers/paymentHandler');
const sevaHandler = require('./handlers/sevaHandler');
const cors = require('cors')({ 
  origin: '*', // Most permissive for troubleshooting
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
});

// Helper to wrap functions with CORS support for Cloud Run/Fetch compatibility
const wrapWithCors = (handler, type = 'call') => {
  if (type === 'call') {
    return functions.https.onCall(async (data, context) => {
      // onCall handles CORS automatically in standard Firebase, 
      // but for Cloud Run/Manual Fetch we ensure it works.
      return handler(data, context);
    });
  }
  return functions.https.onRequest((req, res) => {
    console.log(`BACKEND: Received ${req.method} request for ${req.url}`);
    cors(req, res, () => {
      try {
        return handler(req, res);
      } catch (err) {
        console.error("Handler Error:", err);
        res.status(500).json({ error: { message: err.message } });
      }
    });
  });
};

// --- AUTHENTICATION ---
exports.onUserCreate = functions.auth.user().onCreate(authHandler.onUserCreate);

// --- EVENTS ---
exports.createEvent = wrapWithCors(eventHandler.createEvent);
exports.getEvents = wrapWithCors(eventHandler.getEvents);

// --- ATTENDANCE ---
exports.verifyAttendance = wrapWithCors(attendanceHandler.verifyAttendance);

// --- SADHANA ---
exports.submitSadhana = wrapWithCors(sadhanaHandler.submitSadhana);
exports.getSadhanaMe = wrapWithCors(sadhanaHandler.getSadhanaMe);
exports.getSadhanaAdmin = wrapWithCors(sadhanaHandler.getSadhanaAdmin);

// --- ACCOMMODATION ---
exports.updateAccommodationStatus = wrapWithCors(accommodationHandler.updateAccommodationStatus);

// --- SEVAS ---
exports.createSeva = wrapWithCors(sevaHandler.createSeva);
exports.joinSeva = wrapWithCors(sevaHandler.joinSeva);
exports.cancelSeva = wrapWithCors(sevaHandler.cancelSeva);
exports.getSevas = wrapWithCors(sevaHandler.getSevas);
exports.getMySevas = wrapWithCors(sevaHandler.getMySevas);
exports.getSevaParticipants = wrapWithCors(sevaHandler.getSevaParticipants);
exports.markSevaAttendance = wrapWithCors(sevaHandler.markAttendance);

// --- PAYMENTS ---
exports.createOrder = wrapWithCors(paymentHandler.createOrder);
exports.razorpayWebhook = wrapWithCors(paymentHandler.razorpayWebhook, 'request');

// --- TEST ---
exports.ping = wrapWithCors((req, res) => {
  res.json({ result: { success: true, message: 'pong' } });
}, 'request');
