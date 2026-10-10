'use strict';

const { errorBody } = require('../utils/errors');

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
    return res.status(429).json(
      errorBody('Too many requests. Please wait a few minutes and try again.', 'RESOURCE_EXHAUSTED')
    );
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

const MIN = 60 * 1000;
const WINDOW_15M = 15 * MIN;
const WINDOW_1H = 60 * MIN;

// Every limiter in use, in one place. Same names share a bucket (as before:
// dbGet and dbQuery both count against "dbRead").
const limits = {
  dbRead: rateLimit({ name: 'dbRead', windowMs: WINDOW_15M, max: 6000 }),
  dbWrite: rateLimit({ name: 'dbWrite', windowMs: WINDOW_15M, max: 1500 }),
  dbChanges: rateLimit({ name: 'dbChanges', windowMs: WINDOW_15M, max: 4000 }),
  dbCopy: rateLimit({ name: 'dbCopy', windowMs: WINDOW_1H, max: 5 }),
  uploads: rateLimit({ name: 'uploads', windowMs: WINDOW_15M, max: 300 }),
  verifyPayment: rateLimit({ name: 'verifyPayment', windowMs: WINDOW_15M, max: 60 }),
  createAdmin: rateLimit({ name: 'createAdmin', windowMs: WINDOW_15M, max: 20 }),
  // Per-IP caps for OTP are generous: a whole hall of people signing up at an
  // event can share one Wi-Fi address; the per-phone limits do the fine work.
  sendOtp: rateLimit({ name: 'sendOtp', windowMs: WINDOW_15M, max: 30 }),
  verifyOtp: rateLimit({ name: 'verifyOtp', windowMs: WINDOW_15M, max: 100 }),
  broadcast: rateLimit({ name: 'broadcast', windowMs: WINDOW_1H, max: 20 }),
  backfill: rateLimit({ name: 'backfill', windowMs: WINDOW_1H, max: 5 }),
};

module.exports = { rateLimit, limits };
