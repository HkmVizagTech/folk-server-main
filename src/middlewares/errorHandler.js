'use strict';

const { errorBody } = require('../utils/errors');
const log = require('../utils/logger').create('http');

// Last-resort Express error handler. Route handlers catch their own errors;
// this covers middleware failures (malformed JSON, body too large, ...).
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) log.error('Unhandled error:', err);
  const message = status === 500 ? 'Internal Server Error' : (err.message || 'Bad request');
  return res.status(status).json(errorBody(message, status === 500 ? 'INTERNAL' : 'INVALID_ARGUMENT'));
};

module.exports = { errorHandler };
