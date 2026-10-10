'use strict';

const { createContext } = require('./auth');
const { toErrorBody } = require('../utils/errors');
const log = require('../utils/logger').create('onCall');

/**
 * Adapt a Firebase-onCall style handler `(data, context) => result` to Express.
 * Request `{ data }` (or the bare body) -> `handler(data, context)` ->
 * response `{ result }`. Thrown errors become `{ error: { message, status, code? } }`.
 */
const handleOnCall = (handler) => async (req, res) => {
  try {
    const context = await createContext(req);

    // onCall clients wrap data in `req.body.data`. req.body is undefined when
    // the request has no JSON body (Express 5), so guard it.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = body.data !== undefined && body.data !== null ? body.data : body;

    const result = await handler(data, context);
    res.status(200).json({ result });
  } catch (error) {
    log.error('Handler Error:', error);
    const { httpStatus, body } = toErrorBody(error);
    res.status(httpStatus).json(body);
  }
};

module.exports = { handleOnCall };
