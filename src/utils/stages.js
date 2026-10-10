'use strict';

/**
 * A member's journey stage: the one server-side copy of the client's
 * stageOf() (folk-client/src/content/journey.js). Used by the data policies
 * (canSeeEvent for residents events) and by the broadcast service.
 *
 * Order: `stage` when it is a known id, else the text `level` label the
 * Profile page writes ('FOLK New', 'Initiated', ...), else a numeric level
 * 1..5 from older profiles, else 'new'.
 */
const STAGE_IDS = ['new', 'regular', 'practising', 'committed', 'resident'];

// Keep in step with LEVEL_STAGES in the client's journey.js (lower-cased, trimmed labels).
const LEVEL_STAGES = {
  'folk new': 'new',
  'folk enhanced': 'regular',
  'pre-initiated': 'practising',
  'initiated': 'committed',
};

const stageOf = (u) => {
  if (u && STAGE_IDS.includes(u.stage)) return u.stage;
  const fromLabel = LEVEL_STAGES[String(u && u.level != null ? u.level : '').trim().toLowerCase()];
  if (fromLabel) return fromLabel;
  const n = parseInt(u && u.level, 10);
  return Number.isInteger(n) && n >= 1 && n <= STAGE_IDS.length ? STAGE_IDS[n - 1] : 'new';
};

module.exports = { STAGE_IDS, LEVEL_STAGES, stageOf };
