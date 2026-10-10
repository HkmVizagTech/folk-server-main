'use strict';

const { db } = require('../config/firebase');
const env = require('../config/env');
const { hmacSha256Hex, safeEqualStrings } = require('../utils/crypto');
const { confirmTripSeat, expectedPaiseOf, ts } = require('./payment.service');
const log = require('../utils/logger').create('razorpay');

// Apply one webhook event to the payment doc inside a transaction: webhooks
// for the same order can arrive together or out of order (Razorpay retries,
// and an order can have a failed attempt followed by a successful one).
const applyWebhookEvent = (paymentRef, event, entity) => db.runTransaction(async (t) => {
  const paymentSnap = await t.get(paymentRef);
  if (!paymentSnap.exists) return 'unknown';
  const current = paymentSnap.data();

  if (event === 'payment.captured') {
    const expectedPaise = expectedPaiseOf(current);
    const paidPaise = Number(entity.amount);
    const currency = String(entity.currency || 'INR').toUpperCase();

    // Money arrived, but not the amount this order was created for (or in
    // another currency). Record it for staff instead of marking it settled.
    if (paidPaise !== expectedPaise || currency !== 'INR') {
      t.set(paymentRef, {
        status: 'amount_mismatch',
        verified: false,
        paymentId: entity.id || null,
        method: entity.method || null,
        paidAmountPaise: Number.isFinite(paidPaise) ? paidPaise : null,
        paidCurrency: currency,
        capturedAt: ts(),
      }, { merge: true });
      return 'mismatch';
    }

    // Webhook enforces truth over client updates.
    t.set(paymentRef, {
      status: 'completed',
      verified: true,
      paymentId: entity.id || null,
      method: entity.method || null,
      capturedAt: ts(),
    }, { merge: true });
    return 'captured';
  }

  // payment.failed: a failed attempt must never undo a captured payment on
  // the same order (the failure webhook can arrive after the success).
  const failureReason = entity.error_description || entity.failure_reason || null;
  if (current.status === 'completed' || current.status === 'amount_mismatch') {
    t.set(paymentRef, { lastFailedAttempt: { paymentId: entity.id || null, reason: failureReason } }, { merge: true });
    return 'failed-ignored';
  }
  t.set(paymentRef, { status: 'failed', verified: false, failureReason, failedAt: ts() }, { merge: true });
  return 'failed';
});

/**
 * Process a Razorpay webhook delivery. Returns `{ status, text }` for the
 * controller to send; never throws for a bad payload (this route is reachable
 * by unauthenticated callers, and an escaped rejection would crash the
 * process). Firestore/network hiccups give 500 so Razorpay retries.
 */
const handleWebhook = async ({ rawBody, signature, body }) => {
  try {
    const secret = env.razorpay.webhookSecret;
    if (!secret) {
      log.error('RAZORPAY_WEBHOOK_SECRET not set; webhook disabled.');
      return { status: 500, text: 'Webhook secret not configured' };
    }

    // The signature must be computed over the RAW request body (captured
    // before JSON parsing); re-serialising doesn't reproduce Razorpay's bytes.
    if (!rawBody || typeof signature !== 'string' || !signature) {
      return { status: 400, text: 'Invalid signature' };
    }
    if (!safeEqualStrings(hmacSha256Hex(secret, rawBody), signature)) {
      return { status: 400, text: 'Invalid signature' };
    }

    const event = body && body.event;
    const entity = body && body.payload && body.payload.payment && body.payload.payment.entity;
    const orderId = entity && entity.order_id;

    // The signature is real, but the payload SHAPE isn't guaranteed for every
    // event type/test call: acknowledge anything unrecognised.
    if (!orderId || (event !== 'payment.captured' && event !== 'payment.failed')) {
      return { status: 200, text: 'ok' };
    }

    const paymentRef = db.collection('payments').doc(String(orderId));
    const outcome = await applyWebhookEvent(paymentRef, event, entity);

    if (outcome === 'unknown') {
      // No matching order (e.g. a dashboard test event): nothing to reconcile.
      log.warn(`Webhook for unknown order ${orderId} (${event})`);
    } else if (outcome === 'mismatch') {
      log.error(`Amount mismatch on order ${orderId}: paid ${entity.amount} ${entity.currency}`);
    } else {
      log.info(`${event} for order ${orderId} -> ${outcome}`);
    }
    if (outcome === 'captured') {
      const fresh = await paymentRef.get();
      if (fresh.exists) await confirmTripSeat(fresh.data());
    }
    return { status: 200, text: 'ok' };
  } catch (error) {
    log.error('Webhook handler error:', error);
    return { status: 500, text: 'Webhook processing error' };
  }
};

module.exports = { handleWebhook };
