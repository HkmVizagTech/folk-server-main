'use strict';

const express = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const { attachAuthContext } = require('../middlewares/auth');
const uploads = require('../controllers/upload.controller');

const router = express.Router();

// The browser POSTs raw image bytes and the server forwards them to R2, which
// keeps the bucket free of a CORS policy. express.raw() (not express.json())
// handles this route: the body is binary, and the JSON parser both caps far
// lower and would corrupt it. Keep the limit in step with MAX_BYTES in upload.service.
router.post(
  '/uploadImage',
  limits.uploads,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }),
  attachAuthContext,
  uploads.uploadImage
);
router.post('/deleteUpload', limits.uploads, handleOnCall(uploads.deleteUpload));
router.post('/uploadConfig', handleOnCall(uploads.uploadConfig));

module.exports = router;
