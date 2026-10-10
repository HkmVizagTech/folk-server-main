'use strict';

const { errorBody } = require('../utils/errors');

// Status stays 404: the client reads it as "backend is an outdated build without this route".
const notFound = (req, res) => {
  res.status(404).json(errorBody(`Cannot ${req.method} ${req.path}`, 'NOT_FOUND'));
};

module.exports = { notFound };
