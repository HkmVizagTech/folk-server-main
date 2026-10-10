'use strict';

/**
 * Legacy documents for every collection, as the old generic store held them
 * (camelCase keys, timestamps as ISO strings). Built from SCHEMA_INVENTORY.md:
 * normal client-written docs, legacy/server variants, and deliberately dirty
 * ones (wrong types, unknown keys, explicit nulls, duplicate natural keys,
 * composite ids, mock event ids).
 */
const T1 = '2026-01-02T03:04:05.678Z';
const T2 = '2026-02-03T04:05:06.007Z';
const T3 = '2026-03-04T05:06:07.100Z';

const traveller = (n) => ({ name: `Traveller ${n}`, age: 20 + n, gender: 'Male', idType: 'aadhaar', idNumber: `1234${n}`, college: 'GITAM', course: 'BTech', year: '2nd year' });

const FIXTURES = {
  users: [
    { id: 'uidAdmin1', data: { uid: 'uidAdmin1', name: 'Site Admin', email: 'admin@folkvizag.app', phone: '+91 98765 43210', phoneNormalized: '919876543210', role: 'admin', username: 'admin', streak: 0, score: 0, createdAt: T1, updatedAt: T2, qrToken: 'qr-0001' } },
    { id: 'uidGuide1', data: { uid: 'uidGuide1', name: 'Guide One', role: 'folks_head', phone: '9876500001', phoneNormalized: '919876500001', stage: 'resident', createdAt: T1 } },
    { id: 'uidDev1', data: { uid: 'uidDev1', name: 'Devotee One', fullName: 'Devotee One Full', displayName: 'D1', email: '', phone: '98765 00002', role: 'devotee', level: '2', stage: 'regular', guideId: 'uidGuide1', guideName: 'Guide One', guidePhone: '9876500001', gender: 'Male', dob: '2001-05-17', city: 'Vizag', state: 'AP', country: 'India', streak: 4, longestStreak: 9, score: 120, lastSadhanaDate: '2026-10-09', lastCompletedSadhanaDate: '2026-10-09', nextFollowUpDate: '2026-10-20', lastFollowUpAt: T2, lastFollowUpNote: 'called', photo: 'data:image/jpeg;base64,AAAA', profileImage: 'data:image/jpeg;base64,AAAA', qrToken: 'FOLK-ABC-123456', createdAt: T1, updatedAt: T3, metadata: { location: 'Vizag', source: 'web' } } },
    // staff-created profile without a login (composite-ish id), legacy numeric level, unknown keys
    { id: 'manual_6f1c2d3e-aaaa-bbbb-cccc-000000000001', data: { uid: 'manual_6f1c2d3e-aaaa-bbbb-cccc-000000000001', name: 'Manual Person', role: 'devotee', level: 'FOLK Enhanced', hobby: 'mridanga', tags: ['a', 'b'], prefs: { theme: 'dark', n: 3 }, createdAt: T1 } },
    // dirty: wrong types, unknown enum, impossible date, negative counters, null / missing, timestamp without millis
    { id: 'dirtyUser', data: { name: 12345, role: 'superuser', stage: 'Resident', streak: '7', score: -5, longestStreak: 2.5, dob: '2000-02-30', nextFollowUpDate: '', lastFollowUpAt: '2026-01-02T03:04:05Z', createdAt: 1700000000000, email: null, phone: 9876543210, metadata: 'not an object', spouseId: 'uidDev1' } },
    // duplicate qrToken: second owner must keep its document (key moves to extra)
    { id: 'dupQrUser', data: { name: 'Dup QR', role: 'devotee', qrToken: 'qr-0001', createdAt: T1 } },
  ],
  events: [
    { id: 'evt1', data: { title: 'Sunday Program', category: 'Weekly Program', date: 'Sun, Oct 11, 6:30 PM', dateISO: '2026-10-11T13:00:00.000Z', location: 'Temple', description: 'Kirtan and class', img: 'https://cdn.example/e.jpg', audience: 'all', ownerId: 'uidAdmin1', ownerName: 'Site Admin', groupId: 'uidAdmin1', attendingCount: 3, declinedCount: 1, createdAt: T1, updatedAt: T2 } },
    { id: 'evt2', data: { title: 'Guide circle', category: 'Seminars', date: 'Mon, Oct 12', dateISO: '2026-10-12T12:30:00.000Z', audience: 'mine', ownerId: 'uidGuide1', groupId: 'system', createdAt: T2 } },
    // legacy server-created: raw date string, time, createdBy, attendees, status; unknown audience
    { id: 'evtLegacy', data: { title: 'Old event', date: '2025-12-25', time: '18:30', location: '', description: '', audience: 'everyone', createdBy: 'uidAdmin1', attendees: 40, status: 'active', attendingCount: -2, createdAt: T1 } },
    { id: 'evtDirty', data: { title: 'Dirty', dateISO: 'tomorrow', attendingCount: '5', declinedCount: null, img: 42 } },
  ],
  event_secrets: [
    { id: 'evt1', data: { attendanceToken: 'A1B2C3D4', createdAt: T1 } },
    // orphan: its event was deleted by the client; cannot satisfy the FK -> migration_rejects
    { id: 'evtDeletedLongAgo', data: { attendanceToken: 'DEADBEEF', createdAt: T1 } },
  ],
  registrations: [
    { id: 'evt1_uidDev1', data: { eventId: 'evt1', eventTitle: 'Sunday Program', userId: 'uidDev1', userName: 'Devotee One', token: 'AB12CD34', status: 'Attending', updatedAt: T2 } },
    { id: 'evt1_uidGuide1', data: { eventId: 'evt1', eventTitle: 'Sunday Program', userId: 'uidGuide1', userName: 'Guide One', token: null, status: 'Not Attending', updatedAt: T2 } },
    // mock event id (no events row) and legacy lowercase status
    { id: 'mock1_uidDev1', data: { eventId: 'mock1', eventTitle: 'Mock', userId: 'uidDev1', token: null, status: 'attending', updatedAt: T3 } },
    // id and fields disagree and clash with evt1_uidDev1 on (eventId,userId)
    { id: 'evt1_uidDev1_copy', data: { eventId: 'evt1', userId: 'uidDev1', status: 'Cancelled', updatedAt: T3 } },
  ],
  attendance: [
    { id: 'evt1_uidDev1', data: { userId: 'uidDev1', name: 'Devotee One', eventId: 'evt1', session: 'Sunday Program', status: 'On-time', method: 'roll-call', markedBy: 'uidGuide1', markedByName: 'Guide One', time: '06:30 PM', createdAt: T2 } },
    { id: 'evt1_uidGuide1', data: { userId: 'uidGuide1', uid: 'uidGuide1', eventId: 'evt1', status: 'present', method: 'self-check-in', timestamp: T2, createdAt: T2 } },
    { id: 'mock2_uidDev1', data: { userId: 'uidDev1', eventId: 'mock2', createdAt: T3 } },
  ],
  prasadam_logs: [
    { id: 'evt1_uidDev1', data: { userId: 'uidDev1', name: 'Devotee One', eventId: 'evt1', eventTitle: 'Sunday Program', received: true, timestamp: T2 } },
    { id: 'evt1_uidGuide1', data: { userId: 'uidGuide1', eventId: 'evt1', received: 'yes', timestamp: 'Oct 10' } },
  ],
  sadhana_logs: [
    { id: 'uidDev1_2026-10-09', data: { userId: 'uidDev1', date: '2026-10-09', target: 16, roundsCompleted: 16, progressPercentage: 100, streak: 4, score: 42, status: 'locked', completed: true, createdAt: T1, updatedAt: T2 } },
    { id: 'uidDev1_2026-10-08', data: { userId: 'uidDev1', date: '2026-10-08', userName: 'Devotee One', target: 8, roundsCompleted: 4, progressPercentage: 50, streak: 3, score: 8, status: 'locked', completed: false, bonusClaimed: [3], createdAt: T1 } },
    { id: 'uidDev1_2026-10-07', data: { userId: 'uidDev1', date: '2026-10-07', target: null, roundsCompleted: 65.5, progressPercentage: 130, score: -3, createdAt: T1 } },
  ],
  sevas: [
    { id: 'seva1', data: { title: 'Temple cleaning', description: 'Sweep', sevaType: 'cleaning', date: '2026-10-12', time: '18:30', location: 'Temple', maxVolunteers: 10, isRecurring: false, countRegistered: 2, createdBy: 'uidAdmin1', createdAt: T1, note: 'spread from form' } },
    { id: 'seva2', data: { title: 'Cooking', sevaType: 'kitchen', date: 'next Sunday', maxVolunteers: '10', countRegistered: -1, isRecurring: 'no' } },
  ],
  seva_registrations: [
    { id: 'uidDev1_seva1', data: { userId: 'uidDev1', sevaId: 'seva1', sevaTitle: 'Temple cleaning', userName: 'Devotee One', userPhone: '9876500002', status: 'registered', createdAt: T1, updatedAt: T1 } },
    { id: 'uidGuide1_seva1', data: { userId: 'uidGuide1', sevaId: 'seva1', status: 'completed', createdAt: T1 } },
  ],
  trips: [
    { id: 'trip1', data: { slug: 'srikurmam-yatra', title: 'Srikurmam Yatra', subtitle: 'Kurma-kshetra', location: 'Srikurmam', description: 'p1\n\np2', coverImage: '', gallery: [], startDate: '2026-10-10', endDate: '2026-10-10', durationLabel: '1 day', price: 49, originalPrice: 1300, advanceAmount: 0, capacity: 25, eligibility: 'Boys only', status: 'upcoming', registrationOpen: true, onlinePaymentEnabled: true, cashPaymentEnabled: false, highlights: ['Darshan', 'Prasadam'], itinerary: [{ day: 1, title: 'Travel', details: 'Bus' }], locations: [{ id: 'loc-1', name: 'Temple', description: '', image: '' }], inclusions: ['Travel'], exclusions: [], meetingPoint: 'FOLK Residency', contactPhone: '8977761187', createdBy: 'seed', createdAt: T1, updatedAt: T1 } },
    { id: 'trip2', data: { slug: 'arunachala', title: 'Arunachala', price: 1234.5, originalPrice: 0.1 + 0.2, advanceAmount: 500, capacity: 0, status: 'draft', gallery: ['https://a/1.jpg', 'https://a/2.jpg'], highlights: ['ok', 7], startDate: '2026-12-01', endDate: '2026-12-05' } },
    // duplicate slug (typed uniqueness would be violated)
    { id: 'trip3', data: { slug: 'arunachala', title: 'Arunachala (copy)', status: 'Upcoming', price: '49', registrationOpen: 1 } },
  ],
  trip_registrations: [
    { id: 'treg1', data: { tripId: 'trip1', tripSlug: 'srikurmam-yatra', tripTitle: 'Srikurmam Yatra', userId: 'uidDev1', userName: 'Devotee One', userPhone: '9876500002', userEmail: 'd1@example.org', seats: 2, amountDue: 98, paymentMode: 'online', paymentOrderId: 'order_ABC123', status: 'confirmed', confirmedBy: 'payment', staffNotes: '', cashCollected: false, travellers: [traveller(1), traveller(2)], emergencyContact: 'Mom 9999999999', pickup: 'Gate 1', travellerNotes: 'veg', createdAt: T1, updatedAt: T2 } },
    { id: 'treg2', data: { tripId: 'trip1', userId: 'uidGuide1', seats: 1, amountDue: 49, paymentMode: 'cash', paymentOrderId: null, status: 'pending', cashCollected: true, cashAmount: 49, cashCollectedAt: T2, cashCollectedBy: 'Guide One', createdAt: T1 } },
    { id: 'treg3', data: { tripId: 'trip1', userId: 'uidDev1', seats: '3', amountDue: 'free', status: 'Pending', paymentMode: 'upi', travellers: 'none', cashAmount: 12.345, createdAt: T1 } },
    { id: 'treg4', data: { tripId: 'trip1', userId: 'uidDev1', seats: 25, status: 'waitlisted', travellers: [], createdAt: T1 } },
  ],
  payments: [
    { id: 'order_ABC123', data: { userId: 'uidDev1', amount: 98, amountPaise: 9800, currency: 'INR', purpose: 'trip', tripId: 'trip1', tripRegistrationId: 'treg1', eventId: 'trip1', status: 'completed', verified: true, paymentId: 'pay_XYZ', method: 'upi', verifiedBy: 'checkout', capturedAt: T2, createdAt: T1 } },
    { id: 'order_DON001', data: { userId: 'uidDev1', amount: 501.5, amountPaise: 50150, currency: 'INR', purpose: 'donation', eventId: null, status: 'failed', verified: false, failureReason: 'declined', failedAt: T2, lastFailedAttempt: { paymentId: 'pay_1', reason: 'declined' }, createdAt: T1 } },
    // legacy: no purpose / amountPaise, odd status, huge paise
    { id: 'order_OLD', data: { userId: 'uidDev1', amount: 10, status: 'authorized', paidAmountPaise: 9007199254740993, paidCurrency: 'USD', razorpayOrderId: 'order_OLD' } },
  ],
  accommodation_requests: [
    { id: 'acc1', data: { type: 'Dormitory Bed', guestCount: 2, arrivalDate: '2026-10-15', departureDate: '2026-10-17', requirements: 'ground floor', userId: 'uidDev1', userName: 'Devotee One', status: 'pending', createdAt: T1 } },
    { id: 'acc2', data: { type: 'Family Apartment', guestCount: 0, arrivalDate: '15/10/2026', userId: 'uidDev1', status: 'maybe', createdAt: T2, updatedAt: T3 } },
  ],
  hostel_listings: [
    { id: 'host1', data: { name: 'FOLK Residency', description: 'Boys hostel', capacity: 20, amenities: ['wifi', 'laundry'], img: 'data:image/jpeg;base64,BBBB', active: true, createdBy: 'uidAdmin1', createdAt: T1 } },
    { id: 'host2', data: { name: 'Annex', capacity: '8', amenities: 'wifi, tv' } },
  ],
  hostel_bookings: [
    { id: 'hb1', data: { listingId: 'host1', listingName: 'FOLK Residency', userId: 'uidDev1', userName: 'Devotee One', checkIn: '2026-10-15', checkOut: '2026-10-16', guestCount: 1, notes: '', status: 'pending', createdAt: T1 } },
    { id: 'hb2', data: { listingId: 'gone', userId: 'uidDev1', checkIn: '2026-13-45', status: 'Approved', staffNotes: 'ok', createdAt: T2, updatedAt: T3 } },
  ],
  courses: [
    { id: 'course1', data: { title: 'Bhakti Shastri', description: 'BG study', sessions: 12, schedule: 'Sat 5pm', active: true, createdBy: 'uidAdmin1', createdAt: T1 } },
    { id: 'course2', data: { title: 'Kirtan basics', sessions: 'ten', createdAt: T2 } },
  ],
  enrollments: [
    { id: 'course1_uidDev1', data: { courseId: 'course1', courseTitle: 'Bhakti Shastri', userId: 'uidDev1', userName: 'Devotee One', userPhone: '9876500002', status: 'enrolled', sessionsAttended: 3, createdAt: T1, updatedAt: T2 } },
    { id: 'course1_uidGuide1', data: { courseId: 'course1', userId: 'uidGuide1', status: 'completed', sessionsAttended: 12 } },
  ],
  followups: [
    { id: 'fu1', data: { memberId: 'uidDev1', memberName: 'Devotee One', guideId: 'uidGuide1', guideName: 'Guide One', channel: 'Call', note: 'Spoke about japa', nextDate: '2026-10-20', createdAt: T2 } },
    { id: 'fu2', data: { memberId: 'uidDev1', guideId: 'uidGuide1', note: 'x', nextDate: null, createdAt: T3 } },
  ],
  notifications: [
    { id: 'n1', data: { type: 'new_event', title: 'New event', message: 'Sunday Program', link: '/events', createdAt: T1, createdBy: 'uidAdmin1' } },
  ],
  contact_messages: [
    { id: 'cm1', data: { userId: 'uidDev1', name: 'Devotee One', phone: '9876500002', email: 'd1@example.org', topic: 'Seva', message: 'Hello', status: 'new', createdAt: T1 } },
  ],
  broadcasts: [
    { id: 'bc1', data: { byUid: 'uidAdmin1', byName: 'Site Admin', audience: { type: 'stage', stage: 'regular' }, templateId: 'tpl_1', params: ['a', 'b'], total: 10, sent: 9, failed: 1, createdAt: T1 } },
  ],
  otp_codes: [
    { id: '919876543210', data: { codeHash: 'a'.repeat(64), phone: '919876543210', createdAt: T1, expiresAt: T2, attempts: 1, sends: [1790000000000, 1790000100000] } },
    { id: '919876500001', data: { code: '123456', phone: '919876500001', attempts: 0, sends: [] } },
  ],
  system: [
    { id: 'migration', data: { source: 'firestore', projectId: 'folk-vizag', counts: { users: 5, events: 2 }, firestoreLocked: true, durationMs: 1234, completedAt: T1 } },
    { id: 'seeds', data: { done: ['srikurmam-yatra-2026-10-10'], updatedAt: T1 } },
    { id: 'phoneIndex', data: { version: 1, scanned: 5, updated: 4, builtAt: T1 } },
  ],
  // a collection outside the registry: goes to docs_other
  experiment_notes: [
    { id: 'note1', data: { text: 'hello', nested: { a: [1, 2, { b: null }] }, when: T1 } },
  ],
};

// Documents that cannot be placed (orphan FK) and are expected in migration_rejects.
const EXPECTED_REJECTS = [['event_secrets', 'evtDeletedLongAgo']];

module.exports = { FIXTURES, EXPECTED_REJECTS, T1, T2, T3 };
