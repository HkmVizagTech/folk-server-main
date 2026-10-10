'use strict';

// Document ids are used as path segments, so a '/' would address another
// collection. Reject them (and anything that is not a non-empty string).
const isValidDocId = (value) => typeof value === 'string' && value.length > 0 && !value.includes('/');

const optionalString = (value) => (typeof value === 'string' ? value.trim() : '');

// Plain-object guard used by every onCall handler: `data` may be undefined/null.
const asObject = (data) => (data && typeof data === 'object' ? data : {});

module.exports = { isValidDocId, optionalString, asObject };
