'use strict';

const cors = require('cors');
const env = require('./env');

// CORS: set ALLOWED_ORIGINS (comma-separated) to restrict which websites may
// call the API from a browser. When unset every origin is allowed. The API
// authenticates with Bearer tokens rather than cookies, so an open policy
// doesn't let other sites act as a signed-in user; the allowlist is extra hardening.
const corsMiddleware = () => cors({
  origin: env.allowedOrigins.length
    // Requests without an Origin header (curl, Razorpay's webhook, health
    // checks) aren't browser cross-origin requests, so let them through.
    ? (origin, cb) => cb(null, !origin || env.allowedOrigins.includes(origin))
    : '*',
});

module.exports = { corsMiddleware };
