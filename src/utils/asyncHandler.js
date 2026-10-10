'use strict';

// Express 5 forwards rejected promises to the error handler itself; this
// wrapper keeps the intent explicit and works with any Express version.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
