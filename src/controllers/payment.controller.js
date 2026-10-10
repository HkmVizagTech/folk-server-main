'use strict';

const { validateAuth } = require('../middlewares/auth');
const payments = require('../services/payment.service');
const { handleWebhook } = require('../services/razorpayWebhook.service');
const { asObject } = require('../utils/ids');

// POST /createOrder { amount } | { tripRegistrationId, eventId? }
exports.createOrder = async (data, context) => {
  const uid = await validateAuth(context);
  return payments.createOrder(uid, asObject(data));
};

// POST /paymentConfig (public): is online payment on, plus the PUBLIC key id.
exports.paymentConfig = async () => payments.getPaymentConfig();

// POST /verifyPayment { orderId, paymentId, signature }
exports.verifyPayment = async (data, context) => {
  const uid = await validateAuth(context);
  return payments.verifyPayment(uid, asObject(data));
};

// POST /razorpayWebhook: raw HTTP handler, not onCall.
exports.razorpayWebhook = async (req, res) => {
  const { status, text } = await handleWebhook({
    rawBody: req.rawBody,
    signature: req.headers['x-razorpay-signature'],
    body: req.body,
  });
  return res.status(status).send(text);
};
