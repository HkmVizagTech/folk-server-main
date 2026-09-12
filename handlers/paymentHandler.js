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

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new Error('Amount must be a positive number (max ₹1,00,000 per order).');
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
  // Everything below is wrapped in a single try/catch. This route is the one
  // handler on the whole server that's reachable by an unauthenticated,
  // internet-facing caller with an arbitrary request shape (Razorpay's own
  // retry/test tooling included) - previously an unexpected payload shape
  // (e.g. a missing `entity`, or a payments doc that no longer exists) threw
  // inside this async function with nothing to catch it, which crashes the
  // entire Node process (unhandled promise rejection) and takes the whole
  // API down for every user, not just payments. Now it always resolves with
  // an HTTP response instead.
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[RAZORPAY] RAZORPAY_WEBHOOK_SECRET not set; webhook disabled.');
      return res.status(500).send("Webhook secret not configured");
    }

    // Signature must be computed over the RAW request body (req.rawBody captured
    // before express.json() parsing in server.js). Never JSON.stringify(req.body).
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const signature = req.headers["x-razorpay-signature"];

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const signatureBuffer = Buffer.from(signature || '', 'utf8');
    const signatureValid =
      !!signature &&
      expectedBuffer.length === signatureBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

    if (!signatureValid) {
      return res.status(400).send("Invalid signature");
    }

    const event = req.body && req.body.event;
    const entity = req.body && req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
    const orderId = entity && entity.order_id;

    // Razorpay's own signature is real, but the payload SHAPE isn't
    // guaranteed for every event type/test call - if it's not one we
    // recognize with the fields we need, acknowledge and move on rather
    // than assume `entity`/`orderId` exist.
    if (!orderId || (event !== "payment.captured" && event !== "payment.failed")) {
      return res.status(200).send("ok");
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) {
      // No matching pending order (e.g. a webhook for an order this
      // deployment never created, or a dashboard test event) - nothing to
      // reconcile, but still a valid, handled call.
      console.warn(`[RAZORPAY] Webhook for unknown order ${orderId} (${event})`);
      return res.status(200).send("ok");
    }

    if (event === "payment.captured") {
      // Webhook enforces truth over client updates. set(merge) instead of
      // update() so this can never throw NOT_FOUND even if the doc were
      // deleted between the .get() above and this write.
      await paymentRef.set({
        status: "completed",
        verified: true,
        paymentId: entity.id,
        method: entity.method,
        capturedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`[RAZORPAY] payment.captured for order ${orderId}`);
    } else {
      await paymentRef.set({
        status: "failed",
        verified: false,
        failureReason: entity.error_description || entity.failure_reason || null,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`[RAZORPAY] payment.failed for order ${orderId}`);
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error('[RAZORPAY] Webhook handler error:', error);
    // Firestore/network hiccups return 500 so Razorpay retries the
    // delivery, instead of the request crashing the process.
    return res.status(500).send("Webhook processing error");
  }
};