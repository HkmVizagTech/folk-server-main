/**
 * Who may read and write what through the browser data API (/db).
 *
 * A line-by-line port of folk-client/firestore.rules, which stopped applying
 * once the data moved to Postgres. `before` / `after` are plain JSON
 * documents (null when missing), like `resource.data` / `request.resource.data`.
 * Anything not listed here is denied. Server handlers use `db` directly and
 * are not affected by these checks (same as the Admin SDK before).
 */
const { toJson } = require('./pgstore');

const ROOT_ADMIN_UID = 'wRbvUaFiBOYeXEEtF8OuXnzGWXs2';

// Who an event is for. 'all' is public (it also appears on folkvizag.org);
// 'mine' is the circle of members a FOLK guide looks after; 'residents' is
// the FOLK residency. Anything else is refused.
const EVENT_AUDIENCES = ['all', 'mine', 'residents'];

// A member's journey stage, matching the client's stageOf() (one shared module).
const { stageOf } = require('../utils/stages');

// Profile fields only the team sets (guide, stage, follow-up bookkeeping).
const STAFF_MANAGED_FIELDS = ['stage', 'level', 'guideId', 'guideName', 'guidePhone',
  'nextFollowUpDate', 'lastFollowUpAt', 'lastFollowUpNote'];

const TRIP_STAFF_FIELDS = ['status', 'staffNotes', 'updatedAt',
  'cashCollected', 'cashAmount', 'cashCollectedAt', 'cashCollectedBy'];

// What a devotee may fill in about their own booking after it is made.
// Booking is kept short so a seat can be taken in seconds; these are the
// details the team needs afterwards to buy tickets. Deliberately excludes
// seats, status and anything to do with payment.
const TRIP_OWNER_DETAIL_FIELDS = ['travellers', 'emergencyContact', 'pickup', 'travellerNotes', 'updatedAt'];

const ID_TYPES = ['aadhaar', 'pan', 'passport', 'voter', 'driving', 'student', 'other'];

/** One traveller's details, as typed by the devotee. */
const validTraveller = (t) => {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return false;
  const str = (v, max) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.length <= max);
  if (!str(t.name, 80) || !str(t.gender, 20) || !str(t.idNumber, 40) || !str(t.relation, 40)) return false;
  // Student details: most FOLK members are at college, and the team uses
  // these to group boys and to plan the next campus visit.
  if (!str(t.college, 120) || !str(t.course, 80) || !str(t.year, 24)) return false;
  if (t.idType !== undefined && t.idType !== null && t.idType !== '' && !ID_TYPES.includes(t.idType)) return false;
  if (t.age !== undefined && t.age !== null && t.age !== '') {
    const n = Number(t.age);
    if (!Number.isFinite(n) || n < 1 || n > 120) return false;
  }
  return true;
};

const same = (a, b) => JSON.stringify(toJson(a) ?? null) === JSON.stringify(toJson(b) ?? null);
const keysOf = (d) => Object.keys(d || {});
const affectedKeys = (before, after) => {
  const keys = new Set([...keysOf(before), ...keysOf(after)]);
  return [...keys].filter((k) => !same((before || {})[k], (after || {})[k]));
};
const hasOnly = (keys, allowed) => keys.every((k) => allowed.includes(k));
const hasAny = (keys, list) => keys.some((k) => list.includes(k));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const signedIn = (ctx) => !!ctx.uid;
// A member creating their own profile starts with an empty chanting record.
const freshSadhanaSummary = (u) => ['streak', 'longestStreak', 'score'].every((k) => u[k] === undefined || u[k] === 0);
const isStaff = (ctx) => ctx.role === 'admin' || ctx.role === 'folks_head';
const isSuperAdmin = (ctx) => ctx.role === 'admin';

// "Owner or staff" read used by most per-person collections. A missing
// document is readable (nothing to leak), like `resource == null` in the rules.
const ownerOrStaff = (ctx, id, data) => signedIn(ctx) && (!data || data.userId === ctx.uid || isStaff(ctx));

// ------------------------------------------------------------ sadhana limits
// Derived from the client's sadhanaTx.js: a day's log score is rounds * 2, plus
// 10 once the target is reached, plus a streak bonus when the new streak is
// exactly 3 / 7 / 30 days.
const SADHANA_MAX_ROUNDS = 64;
const SADHANA_MIN_TARGET = 8;
const SADHANA_MAX_TARGET = 64;
const SADHANA_COMPLETION_TARGET = 16; // what admins / folks heads must reach
const SADHANA_BONUS = { 3: 20, 7: 50, 30: 200 };
const SADHANA_MAX_LOG_SCORE = SADHANA_MAX_ROUNDS * 2 + 10 + Math.max(...Object.values(SADHANA_BONUS));
const SADHANA_USER_FIELDS = ['streak', 'longestStreak', 'score', 'lastSadhanaDate', 'lastCompletedSadhanaDate'];

const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const todayIST = () => istDate(new Date());
const yesterdayIST = () => istDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
const isRecentSadhanaDate = (d) => typeof d === 'string' && (d === todayIST() || d === yesterdayIST());

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const maxLogScore = (rounds, completed, streak) => rounds * 2 + (completed ? 10 + (SADHANA_BONUS[streak] || 0) : 0);

/** Is this the write of a sadhana log the real client could have produced? (`before` null = create.) */
const validSadhanaLog = async (ctx, id, before, after, env) => {
  if (after.userId !== ctx.uid || id !== `${ctx.uid}_${after.date}` || !isRecentSadhanaDate(after.date)) return false;
  const rounds = after.roundsCompleted === undefined ? 0 : after.roundsCompleted;
  const score = after.score === undefined ? 0 : after.score;
  const streak = after.streak === undefined ? 0 : after.streak;
  if (!isNonNegInt(rounds) || rounds > SADHANA_MAX_ROUNDS || !isNonNegInt(score) || !isNonNegInt(streak)) return false;
  // Logs written before targets were stored count as 16, like the client's `old.target || 16`.
  const target = after.target === undefined && before && before.target === undefined ? SADHANA_COMPLETION_TARGET : after.target;
  if (!Number.isInteger(target) || target < SADHANA_MIN_TARGET || target > SADHANA_MAX_TARGET) return false;
  const profile = (await env.getBefore(`users/${ctx.uid}`)) || {};
  const carried = isNonNegInt(profile.streak) ? profile.streak : 0;

  if (!before) {
    // Taking the vow: nothing achieved yet, and the chain walked in with is the most it can carry.
    return rounds === 0 && score === 0 && !after.completed && streak <= carried;
  }
  if (before.userId !== ctx.uid || after.date !== before.date || !same(after.target, before.target)) return false;
  const effectiveTarget = isStaff(ctx) ? SADHANA_COMPLETION_TARGET : target;
  const done = rounds >= effectiveTarget;
  if ((after.completed === undefined ? false : after.completed) !== done) return false;
  if (streak > carried + 1) return false;
  return score <= maxLogScore(rounds, done, streak) && score <= SADHANA_MAX_LOG_SCORE;
};

/** An owner's change to the chanting summary on their own profile, bounded by what one log write can do. */
const validSadhanaProfile = async (ctx, id, before, after, env) => {
  const num0 = (v) => (v === undefined || v === null ? 0 : v);
  for (const k of ['streak', 'longestStreak', 'score']) if (!isNonNegInt(num0(after[k]))) return false;
  for (const k of ['lastSadhanaDate', 'lastCompletedSadhanaDate']) {
    if (after[k] !== undefined && after[k] !== null && !isRecentSadhanaDate(after[k])
        && !same(after[k], (before || {})[k])) return false;
  }
  const was = { streak: num0(before && before.streak), longest: num0(before && before.longestStreak), score: num0(before && before.score) };
  const now = { streak: num0(after.streak), longest: num0(after.longestStreak), score: num0(after.score) };
  if (now.streak > was.streak + 1 || now.longest > Math.max(was.longest, now.streak)) return false;
  const gain = now.score - was.score;
  if (gain > SADHANA_MAX_LOG_SCORE) return false;
  if (gain > 0 || now.streak > was.streak) {
    // Going up needs today's (or yesterday's) log in the same commit, and the
    // profile can rise by no more than that log did.
    const date = after.lastSadhanaDate;
    if (!isRecentSadhanaDate(date)) return false;
    const path = `sadhana_logs/${id}_${date}`;
    const logAfter = await env.getAfter(path);
    if (!logAfter || logAfter.userId !== id) return false;
    const logBefore = await env.getBefore(path);
    if (gain > (num(logAfter.score) ?? 0) - (num(logBefore && logBefore.score) ?? 0)) return false;
    if (now.streak > was.streak && !(logAfter.completed === true && !(logBefore && logBefore.completed === true))) return false;
  }
  return true;
};

// ------------------------------------------------------------------- reads
// collection → (ctx, id, data) => boolean. `list` says whether a query on the
// collection is allowed at all (results are then filtered document by document).
/**
 * Can this person see this event?
 *
 * Public events stay public (the website lists them signed out). An event a
 * guide made for their own members is visible to that guide, to the members
 * whose guideId is that guide, and to admins — nobody else, which is what
 * keeps it off folkvizag.org.
 */
const canSeeEvent = (ctx, data) => {
  const audience = (data && data.audience) || 'all';
  if (audience === 'all') return true;
  if (!signedIn(ctx)) return false;
  if (isSuperAdmin(ctx)) return true;
  if (data.ownerId && data.ownerId === ctx.uid) return true;
  if (audience === 'mine') return !!ctx.guideId && ctx.guideId === data.ownerId;
  if (audience === 'residents') return ctx.stage === 'resident' || isStaff(ctx);
  return false;
};

const READ = {
  // Rows are filtered one by one by canSeeEvent, so a guide's private event
  // never reaches the public site or another guide's members.
  events: { list: () => true, doc: (ctx, id, data) => canSeeEvent(ctx, data) },
  hostel_listings: { list: () => true, doc: () => true },
  trips: { list: () => true, doc: () => true },
  notifications: { list: signedIn, doc: signedIn },
  sevas: { list: signedIn, doc: signedIn },
  courses: { list: signedIn, doc: signedIn },
  users: { list: signedIn, doc: (ctx, id) => signedIn(ctx) && (ctx.uid === id || isStaff(ctx)) },
  registrations: { list: signedIn, doc: ownerOrStaff },
  sadhana_logs: { list: signedIn, doc: ownerOrStaff },
  attendance: { list: signedIn, doc: ownerOrStaff },
  prasadam_logs: { list: signedIn, doc: ownerOrStaff },
  accommodation_requests: { list: signedIn, doc: ownerOrStaff },
  seva_registrations: { list: signedIn, doc: ownerOrStaff },
  hostel_bookings: { list: signedIn, doc: ownerOrStaff },
  enrollments: { list: signedIn, doc: ownerOrStaff },
  trip_registrations: { list: signedIn, doc: ownerOrStaff },
  payments: { list: signedIn, doc: ownerOrStaff },
  followups: { list: isStaff, doc: isStaff },
  contact_messages: { list: isStaff, doc: isStaff },
  broadcasts: { list: isStaff, doc: isStaff },
  // otp_codes, event_secrets, system: server only.
};

const canList = (ctx, col) => !!READ[col] && READ[col].list(ctx);
const canRead = (ctx, col, id, data) => !!READ[col] && READ[col].doc(ctx, id, data);

// ------------------------------------------------------------------ writes
// Each returns true/false; `env.getBefore(path)` / `env.getAfter(path)` read
// other documents before / after the whole commit (like get / getAfter).
const WRITE = {
  events: async (ctx, { type, before, after }) => {
    if (type === 'create') {
      if (!isStaff(ctx)) return false;
      const audience = after.audience || 'all';
      if (!EVENT_AUDIENCES.includes(audience)) return false;
      // Only an admin publishes to everyone (those events reach the website).
      // A guide creates for their own members or for the residency, and the
      // event is always stamped with them as the owner.
      if (!isSuperAdmin(ctx)) {
        if (audience === 'all') return false;
        if (after.ownerId !== ctx.uid) return false;
      }
      return true;
    }

    if (type === 'delete') {
      return isSuperAdmin(ctx) || (isStaff(ctx) && before.ownerId === ctx.uid);
    }

    // RSVP: any signed-in member may nudge the two counters by one, and
    // nothing else. Checked before the staff rules so staff can RSVP too.
    const changed = affectedKeys(before, after);
    if (hasOnly(changed, ['attendingCount', 'declinedCount'])) {
      if (!signedIn(ctx)) return false;
      for (const k of ['attendingCount', 'declinedCount']) {
        const a = num(after[k]) ?? 0;
        if (a < 0) return false;
        if (k in before && ![-1, 0, 1].includes(a - (num(before[k]) ?? 0))) return false;
      }
      return true;
    }

    if (!isStaff(ctx)) return false;
    if (isSuperAdmin(ctx)) return true;
    // A guide edits their own event, and can neither hand it to someone else
    // nor promote it to the public calendar.
    if (changed.includes('ownerId')) return false;
    if (changed.includes('audience')) {
      if (before.ownerId !== ctx.uid) return false;
      if (!EVENT_AUDIENCES.includes(after.audience || 'all') || (after.audience || 'all') === 'all') return false;
    }
    return !before.ownerId || before.ownerId === ctx.uid;
  },

  notifications: async (ctx, { type }) => (type === 'create' ? isStaff(ctx) : isSuperAdmin(ctx)),

  users: async (ctx, { type, id, before, after }, env) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    const isRoot = ctx.uid === ROOT_ADMIN_UID;
    if (type === 'create') {
      if (ctx.uid === id && !hasAny(keysOf(after), STAFF_MANAGED_FIELDS) && freshSadhanaSummary(after)
          && ((isRoot && after.role === 'admin') || (!isRoot && after.role === 'devotee'))) return true;
      if (isStaff(ctx) && after.role === 'devotee') return true;
      return isSuperAdmin(ctx);
    }
    if (isSuperAdmin(ctx)) return true;
    if (ctx.uid === id && isRoot) return true;
    const changed = affectedKeys(before, after);
    if (changed.includes('role')) return false;
    if (ctx.uid === id && !hasAny(changed, STAFF_MANAGED_FIELDS)) {
      return !hasAny(changed, SADHANA_USER_FIELDS) || validSadhanaProfile(ctx, id, before, after, env);
    }
    return isStaff(ctx) && (before.role || 'devotee') === 'devotee';
  },

  registrations: async (ctx, { type, before, after }) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') return after.userId === ctx.uid;
    return isStaff(ctx) || (ctx.uid === before.userId && after.userId === before.userId && same(after.eventId, before.eventId));
  },

  // The client writes two shapes (see validSadhanaLog): the vow (create) and the
  // day's rounds (update). Anything the client formula cannot produce is refused.
  sadhana_logs: async (ctx, { type, id, before, after }, env) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    if (!signedIn(ctx)) return false;
    return validSadhanaLog(ctx, id, type === 'create' ? null : before, after, env);
  },

  // Staff record attendance (QR check-in and the roll call) and may remove a
  // record again — un-ticking a name in the roll call deletes it, which is
  // how "absent" is stored: no record at all.
  attendance: async (ctx) => isStaff(ctx),
  prasadam_logs: async (ctx, { type }) => (type === 'delete' ? isSuperAdmin(ctx) : isStaff(ctx)),

  // Status changes go through the server's /updateAccommodationStatus.
  accommodation_requests: async (ctx, { type, after }) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') return signedIn(ctx) && after.userId === ctx.uid;
    return false;
  },

  sevas: async (ctx, { type, id, before, after }, env) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') return isStaff(ctx);
    if (isStaff(ctx)) return true;
    if (!signedIn(ctx)) return false;
    if (!hasOnly(affectedKeys(before, after), ['countRegistered'])) return false;
    const was = num(before.countRegistered);
    const now = num(after.countRegistered);
    if (was === null || now === null || now < 0) return false;
    const regPath = `seva_registrations/${ctx.uid}_${id}`;
    const heldBefore = ((await env.getBefore(regPath)) || {}).status === 'registered';
    const heldAfter = ((await env.getAfter(regPath)) || {}).status === 'registered';
    const joined = now === was + 1 && !heldBefore && heldAfter;
    const left = now === was - 1 && heldBefore && !heldAfter;
    if (!joined && !left) return false;
    return !('maxVolunteers' in before) || now <= num(before.maxVolunteers);
  },

  seva_registrations: async (ctx, { type, id, before, after }) => {
    if (!signedIn(ctx) || type === 'delete') return false;
    if (type === 'create') {
      return after.userId === ctx.uid && id === `${ctx.uid}_${after.sevaId}` && after.status === 'registered';
    }
    if (isStaff(ctx)) return true;
    return ctx.uid === before.userId && before.status !== 'completed'
      && after.userId === before.userId && same(after.sevaId, before.sevaId)
      && ['registered', 'cancelled'].includes(after.status);
  },

  hostel_listings: async (ctx) => isStaff(ctx),

  hostel_bookings: async (ctx, { type, before, after }) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') return after.userId === ctx.uid && after.status === 'pending';
    const changed = affectedKeys(before, after);
    if (isStaff(ctx) && hasOnly(changed, ['status', 'staffNotes', 'updatedAt'])) return true;
    return ctx.uid === before.userId && before.status === 'pending'
      && hasOnly(changed, ['status', 'updatedAt']) && after.status === 'cancelled';
  },

  followups: async (ctx, { type, before, after }) => {
    if (type === 'create') {
      return isStaff(ctx) && after.guideId === ctx.uid && typeof after.note === 'string' && after.note.length <= 1500;
    }
    return isSuperAdmin(ctx) || (isStaff(ctx) && before.guideId === ctx.uid);
  },

  courses: async (ctx, { type }) => (type === 'delete' ? isSuperAdmin(ctx) : isStaff(ctx)),

  enrollments: async (ctx, { type, id, after }) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'update') return isStaff(ctx);
    return signedIn(ctx) && after.userId === ctx.uid && id === `${after.courseId}_${ctx.uid}`
      && after.status === 'enrolled' && after.sessionsAttended === 0;
  },

  contact_messages: async (ctx, { type, after }) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'update') return isStaff(ctx);
    return signedIn(ctx) && after.userId === ctx.uid && after.status === 'new'
      && typeof after.message === 'string' && after.message.length <= 2000;
  },

  // seatsTaken is maintained by the database (migration 003); a write that
  // tries to set it to something else is refused. Absent = left alone.
  trips: async (ctx, { type, before, after }) => {
    if (!isStaff(ctx)) return false;
    if (type === 'delete' || !after || !('seatsTaken' in after)) return true;
    const current = type === 'create' ? 0 : (num(before && before.seatsTaken) ?? 0);
    return after.seatsTaken === current;
  },

  // Payment state is never writable from the browser: only a pointer to a
  // Razorpay order the server created for this very registration, or cash
  // recorded by staff.
  trip_registrations: async (ctx, { type, id, before, after }, env) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') {
      return after.userId === ctx.uid && after.status === 'pending'
        && Number.isInteger(after.seats) && after.seats > 0 && after.seats <= 20
        && (after.cashCollected ?? false) === false
        && !hasAny(keysOf(after), ['cashAmount', 'cashCollectedAt', 'cashCollectedBy'])
        && (after.paymentOrderId ?? null) === null;
    }
    const changed = affectedKeys(before, after);
    if (isStaff(ctx) && hasOnly(changed, TRIP_STAFF_FIELDS)) return true;
    if (ctx.uid !== before.userId) return false;

    // Filling in who is travelling, after the seat is taken. A cancelled
    // booking is left alone, and there can never be more travellers than
    // seats paid for.
    if (hasOnly(changed, TRIP_OWNER_DETAIL_FIELDS)) {
      if (String(before.status || '').toLowerCase() === 'cancelled') return false;
      const list = after.travellers;
      if (list !== undefined && list !== null) {
        if (!Array.isArray(list)) return false;
        const seats = Number(before.seats) || 0;
        if (list.length > seats) return false;
        if (!list.every(validTraveller)) return false;
      }
      if (String(after.emergencyContact || '').length > 120) return false;
      if (String(after.pickup || '').length > 120) return false;
      if (String(after.travellerNotes || '').length > 500) return false;
      return true;
    }
    if (hasOnly(changed, ['paymentOrderId', 'updatedAt']) && typeof after.paymentOrderId === 'string') {
      const order = await env.getBefore(`payments/${after.paymentOrderId}`);
      if (order && order.userId === ctx.uid && (order.tripRegistrationId || '') === id) return true;
    }
    return before.status === 'pending' && after.status === 'cancelled' && hasOnly(changed, ['status', 'updatedAt']);
  },
  // payments, broadcasts, otp_codes, event_secrets, system: server only.
};

const canWrite = async (ctx, change, env) => {
  const rule = WRITE[change.collection];
  if (!rule) return false;
  return !!(await rule(ctx, change, env));
};

module.exports = { SADHANA_MAX_LOG_SCORE, canList, canRead, canWrite, affectedKeys, stageOf, canSeeEvent, validTraveller, ROOT_ADMIN_UID, EVENT_AUDIENCES, ID_TYPES, TRIP_OWNER_DETAIL_FIELDS, READ, WRITE };
