'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const payments = require('../controllers/payment.controller');

const router = Router();

router.post('/createOrder', handleOnCall(payments.createOrder));
router.post('/paymentConfig', handleOnCall(payments.paymentConfig));
router.post('/verifyPayment', limits.verifyPayment, handleOnCall(payments.verifyPayment));
// Raw HTTP handler (Razorpay calls it; signature is checked over req.rawBody).
router.post('/razorpayWebhook', payments.razorpayWebhook);

module.exports = router;
