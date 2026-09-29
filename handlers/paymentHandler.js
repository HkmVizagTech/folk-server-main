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

// Free-form donations: the donor chooses the amount, within this cap.
const MAX_DONATION_INR = 100000;
// Sanity cap for server-computed trip amounts (20 seats of a costly yatra).
const MAX_TRIP_ORDER_INR = 1000000;

const toPaise = (inr) => Math.round(inr * 100);

// Work out what a trip registration owes online RIGHT NOW, from the trip's
// own price — never from a number the browser sent. Mirrors TripDetail.jsx:
//   total  = price x seats
//   payNow = advance x seats (capped at total) when an advance is set, else total
const computeTripAmount = async (uid, tripRegistrationId) => {
  if (typeof tripRegistrationId !== 'string' || !tripRegistrationId.trim() || tripRegistrationId.includes('/')) {
    throw new Error('Invalid trip registration.');
  }
  const regRef = db.collection('trip_registrations').doc(tripRegistrationId);
  const regSnap = await regRef.get();
  if (!regSnap.exists || regSnap.data().userId !== uid) {
    throw new Error('Trip registration not found.');
  }
  const reg = regSnap.data();

  if (String(reg.status || '').toLowerCase() === 'cancelled') {
    throw new Error('This registration was cancelled. Please register again.');
  }
  if (reg.cashCollected === true) {
    throw new Error('The yatra team has already recorded a cash payment for this registration.');
  }
  if (reg.paymentOrderId) {
    const prev = await db.collection('payments').doc(String(reg.paymentOrderId)).get();
    if (prev.exists && prev.data().status === 'completed' && prev.data().verified === true) {
      throw new Error('This registration is already paid.');
    }
  }

  const tripSnap = reg.tripId ? await db.collection('trips').doc(String(reg.tripId)).get() : null;
  if (!tripSnap || !tripSnap.exists) throw new Error('This yatra no longer exists.');
  const trip = tripSnap.data();
  if (trip.onlinePaymentEnabled === false) {
    throw new Error('Online payment is switched off for this yatra. Please contact the yatra team.');
  }

  const seats = Number(reg.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 20) {
    throw new Error('This registration has an invalid number of seats.');
  }
  const price = Number(trip.price) || 0;
  const advance = Number(trip.advanceAmount) || 0;
  const total = price * seats;
  const payNow = advance > 0 ? Math.min(advance * seats, total || advance * seats) : total;
  if (!Number.isFinite(payNow) || payNow <= 0) {
    throw new Error('There is nothing to pay online for this yatra.');
  }
  if (payNow > MAX_TRIP_ORDER_INR) {
    throw new Error('This amount is too large to pay online. Please contact the yatra team.');
  }
  return { amount: payNow, regRef, tripId: String(reg.tripId) };
};

exports.createOrder = async (data, context) => {
  const uid = await validateAuth(context);
  data = data && typeof data === 'object' ? data : {};
  const eventId = typeof data.eventId === 'string' && data.eventId ? data.eventId : null;

  let amount;
  let trip = null;
  if (data.tripRegistrationId !== undefined && data.tripRegistrationId !== null) {
    // Trip seat: the server sets the price. Any `amount` the client sent is ignored.
    trip = await computeTripAmount(uid, data.tripRegistrationId);
    amount = trip.amount;
  } else {
    amount = data.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > MAX_DONATION_INR) {
      throw new Error('Amount must be between ₹1 and ₹1,00,000 per order.');
    }
  }

  const amountPaise = toPaise(amount);

  try {
    const options = {
      amount: amountPaise,
      currency: "INR",
      // Razorpay caps receipt at 40 characters.
      receipt: `rcpt_${uid.slice(0, 12)}_${Date.now()}`,
      notes: {
        userId: uid,
        ...(trip ? { tripId: trip.tripId, tripRegistrationId: trip.regRef.id } : {}),
      },
    };

    const order = await getRazorpay().orders.create(options);

    // Track pending payment state (doc keyed by Razorpay order id)
    await db.collection("payments").doc(order.id).set({
      userId: uid,
      amount,
      amountPaise,
      currency: 'INR',
      eventId: eventId || (trip ? trip.tripId : null),
      ...(trip ? { purpose: 'trip', tripId: trip.tripId, tripRegistrationId: trip.regRef.id } : { purpose: 'donation' }),
      status: "pending",
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Point the registration at this order from the server side too, so the
    // link doesn't depend on the browser's follow-up write succeeding.
    if (trip) {
      await trip.regRef.update({
        paymentOrderId: order.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // keyId is Razorpay's public key; the browser needs it to open checkout.
    return { ...order, keyId: process.env.RAZORPAY_KEY_ID };
  } catch (error) {
    console.error('[RAZORPAY] createOrder failed:', error);
    // Razorpay SDK errors carry the reason in error.error.description.
    throw new Error(error?.error?.description || error.message || 'Could not create the payment order.');
  }
};

/**
 * POST /paymentConfig (public)
 * Whether online payment is available, plus the PUBLIC key id for checkout.
 * Lets the website offer payment without its own VITE_RAZORPAY_KEY setting.
 */
exports.paymentConfig = async () => {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const enabled = !!(keyId && process.env.RAZORPAY_KEY_SECRET);
  return { enabled, keyId: enabled ? keyId : '', mode: keyId.startsWith('rzp_live_') ? 'live' : keyId ? 'test' : 'off' };
};

/**
 * POST /verifyPayment { orderId, paymentId, signature }
 * Called by the browser right after Razorpay checkout succeeds. Confirms the
 * payment without depending on the webhook being configured:
 *   1. Razorpay's checkout signature: HMAC-SHA256(orderId|paymentId, key secret)
 *   2. the payment itself, fetched from Razorpay: same order, right amount,
 *      captured (an authorised-only payment is captured here).
 * Idempotent; the webhook, when configured, reaches the same state.
 */
exports.verifyPayment = async (data, context) => {
  const uid = await validateAuth(context);
  const { orderId, paymentId, signature } = data && typeof data === 'object' ? data : {};
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_]{6,64}$/.test(v);
  if (!ok(orderId) || !ok(paymentId) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Invalid payment confirmation.');
  }
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error('Payments are not configured on the server.');

  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))) {
    throw new Error('Payment signature did not match.');
  }

  const paymentRef = db.collection('payments').doc(orderId);
  const snap = await paymentRef.get();
  if (!snap.exists || snap.data().userId !== uid) throw new Error('Payment order not found.');
  const current = snap.data();
  if (current.status === 'completed' && current.verified === true) return { status: 'completed' };

  const rzp = getRazorpay();
  let payment = await rzp.payments.fetch(paymentId);
  const expectedPaise = Number.isFinite(current.amountPaise) ? current.amountPaise : toPaise(Number(current.amount) || 0);
  if (payment.order_id !== orderId) throw new Error('This payment belongs to a different order.');
  if (Number(payment.amount) !== expectedPaise || String(payment.currency).toUpperCase() !== 'INR') {
    await paymentRef.set({ status: 'amount_mismatch', verified: false, paymentId, paidAmountPaise: Number(payment.amount) || null }, { merge: true });
    throw new Error('The amount paid does not match this booking. The team will review it.');
  }
  if (payment.status === 'authorized') {
    payment = await rzp.payments.capture(paymentId, expectedPaise, 'INR');
  }
  if (payment.status !== 'captured') {
    throw new Error(`Payment is ${payment.status}. If money was deducted, it will be refunded automatically by Razorpay.`);
  }

  await paymentRef.set({
    status: 'completed',
    verified: true,
    paymentId,
    method: payment.method || null,
    verifiedBy: 'checkout',
    capturedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await confirmTripSeat(current);
  console.log(`[RAZORPAY] verified payment ${paymentId} for order ${orderId}`);
  return { status: 'completed' };
};

// A paid trip booking confirms the seat straight away (staff can still
// change it). Only pending registrations are touched.
const confirmTripSeat = async (payment) => {
  if (payment.purpose !== 'trip' || !payment.tripRegistrationId) return;
  const regRef = db.collection('trip_registrations').doc(String(payment.tripRegistrationId));
  await db.runTransaction(async (t) => {
    const reg = await t.get(regRef);
    if (!reg.exists || String(reg.data().status || '').toLowerCase() !== 'pending') return;
    t.update(regRef, { status: 'confirmed', confirmedBy: 'payment', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }).catch((e) => console.error('[RAZORPAY] seat confirm failed:', e.message));
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
    // before express.json() parsing in server.js). Re-serialising req.body
    // doesn't reproduce Razorpay's exact bytes, so without the raw body the
    // request is rejected rather than checked against a guess.
    const rawBody = req.rawBody;
    const signature = req.headers["x-razorpay-signature"];
    if (!rawBody || typeof signature !== 'string' || !signature) {
      return res.status(400).send("Invalid signature");
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');
    const signatureValid =
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

    const paymentRef = db.collection("payments").doc(String(orderId));

    // Transaction: webhooks for the same order can arrive together or out of
    // order (Razorpay retries, and an order can have a failed attempt
    // followed by a successful one).
    const outcome = await db.runTransaction(async (t) => {
      const paymentSnap = await t.get(paymentRef);
      if (!paymentSnap.exists) return 'unknown';
      const current = paymentSnap.data();

      if (event === "payment.captured") {
        const expectedPaise = Number.isFinite(current.amountPaise)
          ? current.amountPaise
          : toPaise(Number(current.amount) || 0);
        const paidPaise = Number(entity.amount);
        const currency = String(entity.currency || 'INR').toUpperCase();

        // Money arrived, but not the amount this order was created for (or
        // in another currency). Record it for staff instead of marking the
        // seat or donation as settled.
        if (paidPaise !== expectedPaise || currency !== 'INR') {
          t.set(paymentRef, {
            status: "amount_mismatch",
            verified: false,
            paymentId: entity.id || null,
            method: entity.method || null,
            paidAmountPaise: Number.isFinite(paidPaise) ? paidPaise : null,
            paidCurrency: currency,
            capturedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          return 'mismatch';
        }

        // Webhook enforces truth over client updates.
        t.set(paymentRef, {
          status: "completed",
          verified: true,
          paymentId: entity.id || null,
          method: entity.method || null,
          capturedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return 'captured';
      }

      // payment.failed: a failed attempt must never undo a captured payment
      // on the same order (the failure webhook can arrive after the success).
      const failureReason = entity.error_description || entity.failure_reason || null;
      if (current.status === 'completed' || current.status === 'amount_mismatch') {
        t.set(paymentRef, {
          lastFailedAttempt: { paymentId: entity.id || null, reason: failureReason },
        }, { merge: true });
        return 'failed-ignored';
      }
      t.set(paymentRef, {
        status: "failed",
        verified: false,
        failureReason,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return 'failed';
    });

    if (outcome === 'unknown') {
      // No matching pending order (e.g. a webhook for an order this
      // deployment never created, or a dashboard test event) - nothing to
      // reconcile, but still a valid, handled call.
      console.warn(`[RAZORPAY] Webhook for unknown order ${orderId} (${event})`);
    } else if (outcome === 'mismatch') {
      console.error(`[RAZORPAY] Amount mismatch on order ${orderId}: paid ${entity.amount} ${entity.currency}`);
    } else {
      console.log(`[RAZORPAY] ${event} for order ${orderId} -> ${outcome}`);
    }
    if (outcome === 'captured') {
      const fresh = await paymentRef.get();
      if (fresh.exists) await confirmTripSeat(fresh.data());
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error('[RAZORPAY] Webhook handler error:', error);
    // Firestore/network hiccups return 500 so Razorpay retries the
    // delivery, instead of the request crashing the process.
    return res.status(500).send("Webhook processing error");
  }
};
