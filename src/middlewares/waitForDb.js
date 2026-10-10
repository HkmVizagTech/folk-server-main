'use strict';

const database = require('../services/database.service');
const { errorBody } = require('../utils/errors');

// Hold POST requests until the database is ready (first-start migration).
const waitForDb = async (req, res, next) => {
  await database.init();
  if (database.getError()) {
    return res.status(503).json(
      errorBody('The database is being set up. Please try again in a minute.', 'UNAVAILABLE')
    );
  }
  next();
};

// Only POSTs touch data; GET /health and friends must answer immediately.
const waitForDbOnPost = (req, res, next) => (req.method === 'POST' ? waitForDb(req, res, next) : next());

module.exports = { waitForDb, waitForDbOnPost };
