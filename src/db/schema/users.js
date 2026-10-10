'use strict';
const { t } = require('./dsl');

/** Member / staff profile, also the sadhana aggregate (streak, score) and care state. */
module.exports = {
  collection: 'users',
  table: 'users',
  idFormat: 'Firebase Auth uid, or manual_<uuid> for staff-created profiles without a login',
  columns: [
    t.text('uid'), t.text('name'), t.text('fullName'), t.text('displayName'),
    t.text('email'), t.text('phone'), t.text('phoneNormalized'),
    t.text('photo'), t.text('photoURL'), t.text('profileImage'),
    t.text('role', { enum: ['admin', 'folks_head', 'devotee', 'volunteer'] }),
    t.text('qrToken'), t.text('username'),
    t.ts('createdAt'), t.ts('updatedAt'),
    t.text('gender'), t.date('dob'),
    t.text('occupation'), t.text('qualification'), t.text('city'), t.text('state'),
    t.text('country'), t.text('center'), t.text('address'), t.text('fatherName'), t.text('fatherPhone'),
    t.text('spouseId'),
    t.text('level'),
    t.text('stage', { enum: ['new', 'regular', 'practising', 'committed', 'resident'] }),
    t.text('guideId'), t.text('guideName'), t.text('guidePhone'), t.text('assignedGroup'),
    t.date('nextFollowUpDate'), t.ts('lastFollowUpAt'), t.text('lastFollowUpNote'),
    t.int('streak', { min: 0 }), t.int('longestStreak', { min: 0 }), t.int('score', { min: 0 }),
    t.date('lastSadhanaDate'), t.date('lastCompletedSadhanaDate'), t.int('sadhanaTarget', { min: 0 }),
    t.jsonb('metadata'),
  ],
  // qr_token is looked up by equality and is unique in practice (NULLs are allowed many times).
  unique: [{ columns: ['qr_token'] }],
  indexes: [
    { columns: ['phone_normalized'] }, // OTP login lookup
    { columns: ['phone'] },
    { columns: ['guide_id'] },
    { columns: ['role'] },
    { columns: ['uid'] },
  ],
};
