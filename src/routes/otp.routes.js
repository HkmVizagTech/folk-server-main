'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const otp = require('../controllers/otp.controller');

const router = Router();

// Both are reachable by UNAUTHENTICATED callers (the user has no Firebase
// token yet): that is the point of a login flow. Security lives in the
// service layer: phone format checks, resend/attempt limits, 5-minute TTL,
// single-use codes and a server-only otp_codes collection.
router.post('/sendOtp', limits.sendOtp, handleOnCall(otp.sendOtp));
router.post('/verifyOtp', limits.verifyOtp, handleOnCall(otp.verifyOtp));

module.exports = router;
