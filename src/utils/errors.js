'use strict';

/**
 * Error type thrown by controllers/services. It mirrors the shape of
 * firebase-functions' HttpsError (`code`, `message`, `details`) so the wire
 * format the client already understands does not change, without pulling in
 * the whole firebase-functions package.
 */
const CODES = new Set([
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found',
  'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition',
  'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss',
  'unauthenticated',
]);

class HttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    if (!CODES.has(code)) throw new Error(`Unknown error code: ${code}`);
    this.name = 'HttpsError';
    this.code = code;
    this.details = details;
  }
}

// Error codes mapped to HTTP statuses. 'not-found' deliberately stays 500: the
// client reads a 404 as "backend is an outdated build without this route".
const HTTP_STATUS_BY_CODE = {
  'invalid-argument': 400,
  'failed-precondition': 400,
  'unauthenticated': 401,
  'permission-denied': 403,
  'already-exists': 409,
  'resource-exhausted': 429,
  'aborted': 409,
};

/** Build the {error:{message,status,code?}} body the client expects. */
const toErrorBody = (error) => {
  const httpStatus = HTTP_STATUS_BY_CODE[error.code] || 500;
  return {
    httpStatus,
    body: {
      error: {
        message: error.message || 'Internal Server Error',
        status: httpStatus === 500 ? 'INTERNAL' : String(error.code).toUpperCase().replace(/-/g, '_'),
        // Firestore-style code ('not-found', 'aborted', ...) for the website's data layer.
        ...(typeof error.code === 'string' && /^[a-z-]+$/.test(error.code) ? { code: error.code } : {}),
      },
    },
  };
};

/** Shorthand body for hand-written error responses. */
const errorBody = (message, status) => ({ error: { message, ...(status ? { status } : {}) } });

module.exports = { HttpsError, HTTP_STATUS_BY_CODE, toErrorBody, errorBody };
