'use strict';

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Postgres error -> the Firestore-style codes the HTTP layer understands.
const PG_TO_STORE = {
  '23505': 'already-exists', // unique_violation (natural keys such as trips.slug)
  '23503': 'failed-precondition', // foreign_key_violation
  '23514': 'invalid-argument', // check_violation
  '22P02': 'invalid-argument', // invalid_text_representation
  '22007': 'invalid-argument', // invalid_datetime_format
};

/** Wrap a driver error as a StoreError when we know what it means; otherwise return it unchanged. */
const mapPgError = (e) => {
  if (e instanceof StoreError || !e || !e.code || !PG_TO_STORE[e.code]) return e;
  const out = new StoreError(PG_TO_STORE[e.code], e.detail ? `${e.message} (${e.detail})` : e.message);
  out.pgCode = e.code;
  out.constraint = e.constraint;
  return out;
};

// Serialization failure / deadlock: the whole transaction is simply run again.
const RETRYABLE = new Set(['40001', '40P01']);

module.exports = { StoreError, mapPgError, RETRYABLE };
