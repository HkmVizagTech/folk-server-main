const { db, admin } = require('../config/firebase');
const { validateAuth } = require('../middlewares/auth');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const getRazorpay = () => {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars are required to process payments.');
  }
  return new Razorpay({ key_id, key_secret });
};

exports.createOrder = async (data, context) => {
  const uid = await validateAuth(context);
  const { amount, eventId } = data; // amount in standard format (e.g. INR)

  if (!amount || amount <= 0) {
    throw new Error('Amount must be a positive number.');
  }

  try {
    const options = {
      amount: Math.round(amount * 100), // Convert to paise for Razorpay
      currency: "INR",
      receipt: `receipt_${uid}_${Date.now()}`,
      notes: { userId: uid },
    };

    const order = await getRazorpay().orders.create(options);

    // Track pending payment state (doc keyed by Razorpay order id)
    await db.collection("payments").doc(order.id).set({
      userId: uid,
      amount,
      eventId: eventId || null,
      status: "pending",
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return order;
  } catch (error) {
    console.error('[RAZORPAY] createOrder failed:', error);
    throw new Error(error.message);
  }
};

exports.razorpayWebhook = async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[RAZORPAY] RAZORPAY_WEBHOOK_SECRET not set; webhook disabled.');
    return res.status(500).send("Webhook secret not configured");
  }

  // Signature must be computed over the RAW request body (req.rawBody captured
  // before express.json() parsing in server.js). Never JSON.stringify(req.body).
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');
  const signature = req.headers["x-razorpay-signature"];

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  if (!signature || signature !== expectedSignature) {
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  const entity = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;

  if (event === "payment.captured") {
    const orderId = entity.order_id;

    if (!orderId) {
      return res.status(200).send("ok");
    }

    // Webhook enforces truth over client updates
    await db.collection("payments").doc(orderId).update({
      status: "completed",
      verified: true,
      paymentId: entity.id,
      method: entity.method,
      capturedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`[RAZORPAY] payment.captured for order ${orderId}`);
  } else if (event === "payment.failed") {
    const orderId = entity.order_id;

    if (orderId) {
      await db.collection("payments").doc(orderId).update({
        status: "failed",
        verified: false,
        failureReason: entity.error_description || entity.failure_reason || null,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[RAZORPAY] payment.failed for order ${orderId}`);
    }
  }

  res.status(200).send("ok");
};