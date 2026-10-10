'use strict';

const express = require('express');
const { corsMiddleware } = require('./config/cors');
const routes = require('./routes');
const { waitForDbOnPost } = require('./middlewares/waitForDb');
const { notFound } = require('./middlewares/notFound');
const { errorHandler } = require('./middlewares/errorHandler');

/** Assemble the Express app. No side effects until a request arrives. */
const createApp = () => {
  const app = express();

  // Railway/Render put one proxy in front of the app. Trusting exactly one hop
  // makes req.ip the real client address (used by the rate limiter) without
  // letting a client spoof it through its own X-Forwarded-For header.
  app.set('trust proxy', 1);

  app.use(corsMiddleware());
  app.use(express.json({
    // Express defaults to 100kb, too tight for this app's writes (a trip
    // carries a long description, itinerary and inclusion lists). Images do
    // NOT come through here: they go via POST /uploadImage (raw body).
    limit: '2mb',
    verify: (req, res, buf) => {
      // Preserve the RAW body before parsing so the Razorpay webhook
      // signature can be checked against the exact bytes that were sent.
      req.rawBody = buf;
    },
  }));

  // Wait for the first-start database setup before any POST is served.
  app.use(waitForDbOnPost);

  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
};

module.exports = createApp();
module.exports.createApp = createApp;
