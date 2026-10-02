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

// A member's journey stage, matching the client's stageOf().
const STAGE_IDS = ['new', 'regular', 'practising', 'committed', 'resident'];
const stageOf = (u) => {
  if (u && STAGE_IDS.includes(u.stage)) return u.stage;
  const n = parseInt(u && u.level, 10);
  return Number.isInteger(n) && n >= 1 && n <= STAGE_IDS.length ? STAGE_IDS[n - 1] : 'new';
};

// Profile fields only the team sets (guide, stage, follow-up bookkeeping).
const STAFF_MANAGED_FIELDS = ['stage', 'level', 'guideId', 'guideName', 'guidePhone',
  'nextFollowUpDate', 'lastFollowUpAt', 'lastFollowUpNote'];

const TRIP_STAFF_FIELDS = ['status', 'staffNotes', 'updatedAt',
  'cashCollected', 'cashAmount', 'cashCollectedAt', 'cashCollectedBy'];

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
const isStaff = (ctx) => ctx.role === 'admin' || ctx.role === 'folks_head';
const isSuperAdmin = (ctx) => ctx.role === 'admin';

// "Owner or staff" read used by most per-person collections. A missing
// document is readable (nothing to leak), like `resource == null` in the rules.
const ownerOrStaff = (ctx, id, data) => signedIn(ctx) && (!data || data.userId === ctx.uid || isStaff(ctx));

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
  // First-timers at a program: personal details of people who have no
  // account yet, so the team only.
  visitors: { list: isStaff, doc: isStaff },
  // Whether each attendee's prasadam coupon reached the community app.
  // Written only by the server's sweep, so there is no client write rule.
  prasadam_grants: { list: isStaff, doc: isStaff },
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
        // Prasadam coupons are real meals the kitchen has to cook, so only an
        // admin can put a program on the coupon list.
        if (after.givesPrasadamCoupon) return false;
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
    if (changed.includes('givesPrasadamCoupon')) return false;
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

  users: async (ctx, { type, id, before, after }) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    const isRoot = ctx.uid === ROOT_ADMIN_UID;
    if (type === 'create') {
      if (ctx.uid === id && !hasAny(keysOf(after), STAFF_MANAGED_FIELDS)
          && ((isRoot && after.role === 'admin') || (!isRoot && after.role === 'devotee'))) return true;
      if (isStaff(ctx) && after.role === 'devotee') return true;
      return isSuperAdmin(ctx);
    }
    if (isSuperAdmin(ctx)) return true;
    if (ctx.uid === id && isRoot) return true;
    const changed = affectedKeys(before, after);
    if (changed.includes('role')) return false;
    if (ctx.uid === id && !hasAny(changed, STAFF_MANAGED_FIELDS)) return true;
    return isStaff(ctx) && (before.role || 'devotee') === 'devotee';
  },

  registrations: async (ctx, { type, before, after }) => {
    if (!signedIn(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') return after.userId === ctx.uid;
    return isStaff(ctx) || (ctx.uid === before.userId && after.userId === before.userId && same(after.eventId, before.eventId));
  },

  sadhana_logs: async (ctx, { type, after }) => {
    if (type === 'delete') return isSuperAdmin(ctx);
    return signedIn(ctx) && after.userId === ctx.uid;
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

  trips: async (ctx) => isStaff(ctx),

  // A first-timer taken down at the door. The team can correct the details
  // and tick them off once somebody has welcomed them; only an admin removes
  // the record.
  visitors: async (ctx, { type, before, after }) => {
    if (!isStaff(ctx)) return false;
    if (type === 'delete') return isSuperAdmin(ctx);
    if (type === 'create') {
      return typeof after.name === 'string'
        && after.name.trim().length > 0
        && after.name.length <= 80
        && typeof after.eventId === 'string'
        && after.eventId.length > 0
        && String(after.note || '').length <= 500;
    }
    // Updates may not move a visitor to a different program, which would
    // quietly change who was counted at which event.
    if (after.eventId !== before.eventId) return false;
    return String(after.name || '').length <= 80 && String(after.note || '').length <= 500;
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

module.exports = { canList, canRead, canWrite, affectedKeys, stageOf, canSeeEvent, ROOT_ADMIN_UID, EVENT_AUDIENCES, READ, WRITE };
