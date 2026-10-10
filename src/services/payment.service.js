'use strict';

const Razorpay = require('razorpay');
const { db, admin } = require('../config/firebase');
const env = require('../config/env');
const { hmacSha256Hex, safeEqualStrings } = require('../utils/crypto');
const log = require('../utils/logger').create('razorpay');

const { keyId: KEY_ID, keySecret: KEY_SECRET } = env.razorpay;
const ts = () => admin.firestore.FieldValue.serverTimestamp();

const getRazorpay = () => {
  if (!KEY_ID || !KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars are required to process payments.');
  }
  return new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
};

// Free-form donations: the donor chooses the amount, within this cap.
const MAX_DONATION_INR = 100000;
// Sanity cap for server-computed trip amounts (20 seats of a costly yatra).
const MAX_TRIP_ORDER_INR = 1000000;

const toPaise = (inr) => Math.round(inr * 100);

const expectedPaiseOf = (payment) =>
  (Number.isFinite(payment.amountPaise) ? payment.amountPaise : toPaise(Number(payment.amount) || 0));

// Work out what a trip registration owes online RIGHT NOW, from the trip's
// own price - never from a number the browser sent. Mirrors TripDetail.jsx:
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

  // The previous-payment lookup and the trip lookup are independent reads.
  const [prev, tripSnap] = await Promise.all([
    reg.paymentOrderId ? db.collection('payments').doc(String(reg.paymentOrderId)).get() : null,
    reg.tripId ? db.collection('trips').doc(String(reg.tripId)).get() : null,
  ]);
  if (prev && prev.exists && prev.data().status === 'completed' && prev.data().verified === true) {
    throw new Error('This registration is already paid.');
  }
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

// A paid trip booking confirms the seat straight away (staff can still
// change it). Only pending registrations are touched.
const confirmTripSeat = async (payment) => {
  if (payment.purpose !== 'trip' || !payment.tripRegistrationId) return;
  const regRef = db.collection('trip_registrations').doc(String(payment.tripRegistrationId));
  await db.runTransaction(async (t) => {
    const reg = await t.get(regRef);
    if (!reg.exists || String(reg.data().status || '').toLowerCase() !== 'pending') return;
    t.update(regRef, { status: 'confirmed', confirmedBy: 'payment', updatedAt: ts() });
  }).catch((e) => log.error('seat confirm failed:', e.message));
};

/** Create a Razorpay order and the matching pending payment doc. */
const createOrder = async (uid, data) => {
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
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      // Razorpay caps receipt at 40 characters.
      receipt: `rcpt_${uid.slice(0, 12)}_${Date.now()}`,
      notes: {
        userId: uid,
        ...(trip ? { tripId: trip.tripId, tripRegistrationId: trip.regRef.id } : {}),
      },
    });

    // Track pending payment state (doc keyed by Razorpay order id)
    await db.collection('payments').doc(order.id).set({
      userId: uid,
      amount,
      amountPaise,
      currency: 'INR',
      eventId: eventId || (trip ? trip.tripId : null),
      ...(trip ? { purpose: 'trip', tripId: trip.tripId, tripRegistrationId: trip.regRef.id } : { purpose: 'donation' }),
      status: 'pending',
      verified: false,
      createdAt: ts(),
    });

    // Point the registration at this order from the server side too, so the
    // link doesn't depend on the browser's follow-up write succeeding.
    if (trip) {
      await trip.regRef.update({ paymentOrderId: order.id, updatedAt: ts() });
    }

    // keyId is Razorpay's public key; the browser needs it to open checkout.
    return { ...order, keyId: KEY_ID || undefined };
  } catch (error) {
    log.error('createOrder failed:', error);
    // Razorpay SDK errors carry the reason in error.error.description.
    throw new Error(error?.error?.description || error.message || 'Could not create the payment order.');
  }
};

/** Whether online payment is available, plus the PUBLIC key id for checkout. */
const getPaymentConfig = () => {
  const enabled = !!(KEY_ID && KEY_SECRET);
  return { enabled, keyId: enabled ? KEY_ID : '', mode: KEY_ID.startsWith('rzp_live_') ? 'live' : KEY_ID ? 'test' : 'off' };
};

/**
 * Confirm a payment from the browser's checkout response, without depending
 * on the webhook: checks the HMAC signature, then the payment itself as
 * fetched from Razorpay (same order, right amount, captured). Idempotent.
 */
const verifyPayment = async (uid, { orderId, paymentId, signature }) => {
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_]{6,64}$/.test(v);
  if (!ok(orderId) || !ok(paymentId) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Invalid payment confirmation.');
  }
  if (!KEY_SECRET) throw new Error('Payments are not configured on the server.');

  if (!safeEqualStrings(hmacSha256Hex(KEY_SECRET, `${orderId}|${paymentId}`), signature)) {
    throw new Error('Payment signature did not match.');
  }

  const paymentRef = db.collection('payments').doc(orderId);
  const snap = await paymentRef.get();
  if (!snap.exists || snap.data().userId !== uid) throw new Error('Payment order not found.');
  const current = snap.data();
  if (current.status === 'completed' && current.verified === true) return { status: 'completed' };

  const rzp = getRazorpay();
  let payment = await rzp.payments.fetch(paymentId);
  const expectedPaise = expectedPaiseOf(current);
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
    capturedAt: ts(),
  }, { merge: true });
  await confirmTripSeat(current);
  log.info(`verified payment ${paymentId} for order ${orderId}`);
  return { status: 'completed' };
};

module.exports = { createOrder, getPaymentConfig, verifyPayment, confirmTripSeat, expectedPaiseOf, ts };
