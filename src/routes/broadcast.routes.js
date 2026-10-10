'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const broadcast = require('../controllers/broadcast.controller');

const router = Router();

// WhatsApp template broadcast to a group of members (guides: own members only).
router.post('/broadcast', limits.broadcast, handleOnCall(broadcast.broadcast));
// One-off maintenance: index every profile's phone for fast OTP login lookups.
router.post('/backfillPhoneIndex', limits.backfill, handleOnCall(broadcast.backfillPhoneIndex));

module.exports = router;
