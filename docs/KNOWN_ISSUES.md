# Known issues (client / server / policy disagreements)

These are **existing behaviours that disagree with each other**. The move to typed tables deliberately did
**not** change any of them: controllers, policies, the HTTP contract and the client are untouched, so every
item below behaves exactly as it did on the generic JSON tables. They are listed so they can be decided and
fixed separately (each fix is a product decision, not a schema change). The text is quoted verbatim from
`SCHEMA_INVENTORY.md` section 16 (file:line citations there use the pre-refactor layout).

## Where data-shape assumptions disagree (client vs server vs policies)

1. **Sadhana scoring/target**: client (`sadhanaTx.js:61-66`) two-phase, member target, score `rounds*2 + 10 + bonuses 3/7/30 days`; server `submitSadhana` single-shot target 16, score `10 + 2*extra`, bonuses 3/7 only, requires `date === todayIST`, `rounds` int 0..64, writes `userName`. Policy lets the client write any score/streak. Only the client path is live.
2. **Event `date`**: client stores a locale label (`"Sat, Oct 10, 6:30 PM"`) plus `dateISO`; server `createEvent`/`getEvents` treat `date` as a sortable raw string, and server also writes `time`, `createdBy`, `groupId=uid` only for folks_head. `getEvents` returns events with no audience filtering (public endpoint leaks `mine/residents` events), whereas `/dbQuery` filters by `canSeeEvent`.
3. **Event check-in token**: tokens exist only for events created via server `createEvent`; client creates events directly (no `event_secrets`), so `verifyAttendance` always fails for them.
4. **Attendance shape**: server self check-in writes `status:'present'`, `uid`, `timestamp`, no `name/session`; client rows use `status:'On-time'`, `name`, `session`, `time`. UI counts `On-time` and searches `name/session`, so server rows are invisible in those views. Policy says attendance writes are staff-only but the server bypasses it.
5. **Seva roster/count**: server `markAttendance` treats `completed` as seat-holding and adjusts `countRegistered` on held<->not-held changes; client roster `updateDoc` for `completed` or cancel-from-completed does not adjust the counter. Server `joinSeva` doesn't write `sevaTitle/userName/userPhone` (client roster expects `userName`, otherwise shows `Devotee <uid prefix>`).
6. **stage derivation**: client maps level LABELS ('FOLK New'…); server `stageOf` (policies and broadcast) only maps numeric `level`, so a member with `level:'Initiated'` and no `stage` is `committed` in the UI but `new` for broadcast-by-stage and for `canSeeEvent(residents)`.
7. **Trip seat counting**: client counts from readable rows only; devotees see own seats only (see §8). Capacity never validated server-side.
8. **payments aliases**: client looks for `orderId` / `razorpayOrderId` fields that the server never writes; only `id` (doc id) works.
9. **trip_registrations status case**: server compares `String(status).toLowerCase()`; client/policy write lower-case; `hostel_bookings`/`accommodation_requests` are compared lower-cased on client but policy compares `after.status === 'pending'` exactly. Store lower-case everywhere; consider CHECK constraints only after confirming existing rows.
10. **`users.assignedGroup` vs `guideId`**: server accommodation check uses `assignedGroup`; everything else uses `guideId`; no client code writes `assignedGroup`.
11. **Notifications by devotees**: `useHostelBookings.create` writes a notification as a devotee but `policies.notifications` create = staff, so it is silently denied.
12. **`role: 'volunteer'`** appears in client filters only; policies treat any non-admin/folks_head role as a normal member.
13. **Profile photo fields**: `photo` vs `photoURL` vs `profileImage` (stored twice by `useProfileForm`).
14. **Dead server code**: `authHandler.onUserCreate` (writes `metadata`, name default 'Devotee') is not mounted.
15. **Timestamps in arrays**: `otp_codes.sends` are epoch-ms numbers (not ISO), whereas everywhere else times are ISO strings.

## Additional invariants called out in the inventory

Quoted verbatim from `SCHEMA_INVENTORY.md`:

* Section 8 (trip_registrations): **Invariant (BROKEN as built)**: `seatsLeft = capacity - sum(seats of pending|confirmed regs)` is computed in the browser from the rows the caller can READ. Devotees can only read their own registrations (ownerOrStaff, `policies.js:116`), so the displayed "seats left" for a devotee ignores everyone else's bookings (`useTripDetailData.js:38-48`, `trips/hooks/useTripsData.js:31-40`). No server transaction checks capacity. Recommend: a SQL-side seat counter (view or trigger-maintained `trips.seats_taken`) exposed as a readable field, and a capacity check at insert inside the same transaction.
* Section 5 (sadhana_logs), policy note: **Policy** (`policies.js:202-208`): ANY write requires only `after.userId == uid` (no validation of score/streak/rounds; delete admin). Note this lets a client forge score.

## Cross-collection business invariants and who maintains them

These are maintained by clients / handlers, **not by the database**. The typed schema adds natural-key UNIQUEs
(see SCHEMA.md) but, by design, no triggers or generated counters, so every row in this table is still true:

| invariant | maintained by | notes for typed schema |
|---|---|---|
| events.attendingCount/declinedCount == RSVP statuses | client tx `useRsvp.js` (absolute values); policy checks +-1 | add trigger on `registrations` or keep counters + nightly reconcile |
| sevas.countRegistered == #registrations in (registered, completed) | client tx (join/leave/roster cancel), server handlers; policy checks regs flip in same commit (`policies.js:228-235`) | trigger or generated count; max enforced at join (`count >= maxVolunteers` check) |
| trip seats <= capacity | nobody server-side | add DB check inside booking tx / trigger |
| trip_registration.status -> confirmed when payment verified | server `confirmTripSeat` (verifyPayment + webhook) | idempotent, only from pending |
| enrollment.status vs sessionsAttended | client roster | |
| users.streak/score/longest/lastSadhanaDate vs sadhana_logs | client `sadhanaTx.js` | transaction over (log row, user row) |
| one attendance/prasadam/registration/seva_reg/enrollment/sadhana log per composite id | deterministic doc ids + `create()`/tx existence checks | enforce with UNIQUE or composite PK |
| users.lastFollowUp* mirror followups | client batch | |

## Consequences of the typed schema worth knowing (not bugs, by design)

* Values that do not fit a column (wrong type, unknown enum value such as `status: "Pending"` with capital P,
  `seats: "3"`, a non-calendar date) are stored in the row's `extra` jsonb and read back unchanged; they are not
  visible to range queries / `orderBy` on that column. Case-mismatched statuses in legacy rows are an example of
  inventory item 9 above.
* `orderBy(field)` drops rows whose column is NULL, which now also includes rows that hold an explicit
  `null` in that field (the generic store kept those).
* Natural-key duplicates in legacy data (two `trips` with one `slug`, a repeated `qrToken`, two rows for one
  event+user) keep their documents; the clashing key is moved to `extra` and counted in the migration summary.
