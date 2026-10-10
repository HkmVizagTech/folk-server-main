# Known issues (client / server / policy disagreements)

**Fixed since this list was written** (marked FIXED below): item 1 (policy part: forged scores/streaks; the scoring
formula difference between client and server `submitSadhana` remains), item 2 (`getEvents` audience leak only),
item 6 (stage labels), item 7 and section 8 (trip capacity), and the sadhana forgery note. Everything else is unchanged.

These are **existing behaviours that disagree with each other**. The move to typed tables deliberately did
**not** change any of them: controllers, policies, the HTTP contract and the client are untouched, so every
item below behaves exactly as it did on the generic JSON tables. They are listed so they can be decided and
fixed separately (each fix is a product decision, not a schema change). The text is quoted verbatim from
`SCHEMA_INVENTORY.md` section 16 (file:line citations there use the pre-refactor layout).

## Where data-shape assumptions disagree (client vs server vs policies)

1. **Sadhana scoring/target**: client (`sadhanaTx.js:61-66`) two-phase, member target, score `rounds*2 + 10 + bonuses 3/7/30 days`; server `submitSadhana` single-shot target 16, score `10 + 2*extra`, bonuses 3/7 only, requires `date === todayIST`, `rounds` int 0..64, writes `userName`. Only the client path is live. **FIXED (policy part):** the policy no longer lets the client write any score/streak,
see "Sadhana write limits" below. The two scoring formulas still differ (server `submitSadhana` is unused by the client).
2. **Event `date`**: client stores a locale label (`"Sat, Oct 10, 6:30 PM"`) plus `dateISO`; server `createEvent`/`getEvents` treat `date` as a sortable raw string, and server also writes `time`, `createdBy`, `groupId=uid` only for folks_head. `getEvents` returns events with no audience filtering (public endpoint leaks `mine/residents` events), whereas `/dbQuery` filters by `canSeeEvent`. **FIXED (leak only):** `getEvents` now filters every event with `canSeeEvent` for the
caller (signed out = public events only), and `createEvent` accepts an optional `audience` (`all` admin only / `mine` / `residents`; sets `ownerId`) validated like the events policy. The `date`/`dateISO`
disagreement is unchanged.
3. **Event check-in token**: tokens exist only for events created via server `createEvent`; client creates events directly (no `event_secrets`), so `verifyAttendance` always fails for them.
4. **Attendance shape**: server self check-in writes `status:'present'`, `uid`, `timestamp`, no `name/session`; client rows use `status:'On-time'`, `name`, `session`, `time`. UI counts `On-time` and searches `name/session`, so server rows are invisible in those views. Policy says attendance writes are staff-only but the server bypasses it.
5. **Seva roster/count**: server `markAttendance` treats `completed` as seat-holding and adjusts `countRegistered` on held<->not-held changes; client roster `updateDoc` for `completed` or cancel-from-completed does not adjust the counter. Server `joinSeva` doesn't write `sevaTitle/userName/userPhone` (client roster expects `userName`, otherwise shows `Devotee <uid prefix>`).
6. **stage derivation**: client maps level LABELS ('FOLK New'…); server `stageOf` (policies and broadcast) only maps numeric `level`, so a member with `level:'Initiated'` and no `stage` is `committed` in the UI but `new` for broadcast-by-stage and for `canSeeEvent(residents)`.
**FIXED:** one shared module, `src/utils/stages.js`, maps `stage`, then the level labels (`FOLK New`, `FOLK Enhanced`, `Pre-Initiated`, `Initiated`), then numeric levels, then `new`;
policies and the broadcast service both use it. If the client's `LEVEL_STAGES` in `journey.js` changes, change it there too.
7. **Trip seat counting**: client counts from readable rows only; devotees see own seats only (see §8). Capacity never validated server-side. **FIXED:** `trips.seats_taken` (document field `seatsTaken`, readable by everyone) is
maintained by triggers and capacity is enforced in the database, see "Trip capacity" below.
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

* Section 8 (trip_registrations): **Invariant (BROKEN as built)**: `seatsLeft = capacity - sum(seats of pending|confirmed regs)` is computed in the browser from the rows the caller can READ. Devotees can only read their own registrations (ownerOrStaff, `policies.js:116`), so the displayed "seats left" for a devotee ignores everyone else's bookings (`useTripDetailData.js:38-48`, `trips/hooks/useTripsData.js:31-40`). No server transaction checks capacity. Recommend: a SQL-side seat counter (view or trigger-maintained `trips.seats_taken`) exposed as a readable field, and a capacity check at insert inside the same transaction. **FIXED** (migration 003; the client reads `trip.seatsTaken` and falls back to counting only for servers that do not send it).
* Section 5 (sadhana_logs), policy note: **Policy** (`policies.js:202-208`): ANY write requires only `after.userId == uid` (no validation of score/streak/rounds; delete admin). Note this lets a client forge score. **FIXED:** see "Sadhana write limits".

## Trip capacity (migration 003)

* `trips.seats_taken` = sum of seats of the trip's `trip_registrations` with status `pending` or `confirmed` (case-insensitive; seats = `parseInt(seats) || 1`,
  as the client counts; values kept in `extra` for legacy rows are read too). It is a *derived* column: the store never writes it, a `seatsTaken` in a
  document write is ignored, the policy refuses a staff write that tries to change it, and a trigger on `trips` recomputes it on every write.
* A BEFORE trigger on `trip_registrations` locks the trip row and refuses a write that would raise the held seats past `capacity` with
  SQLSTATE `FL001` (`This yatra is full` / `This yatra is full: only N seats left`), mapped to `failed-precondition` (HTTP 400). Capacity NULL / 0 = unlimited.
  Only writes that take *more* seats than the booking already held are checked, so cancelling, confirming a pending booking, editing details and any staff
  status change that does not add seats are never blocked (also on trips that are already over capacity). Re-opening a cancelled/waitlisted booking is checked like a new one.
* An AFTER trigger recomputes `seats_taken` for the old and new trip of every insert/update/delete. Bulk imports (`importDocuments`, the Firestore copy) skip the capacity check.
* Remaining gaps: a booking whose `tripId` points at no trip is not checked; a trip's `capacity` lowered below the seats already taken is allowed (no new bookings until seats free up).

## Sadhana write limits (policy)

`policies.js` (`validSadhanaLog`, `validSadhanaProfile`) now allows only what `sadhanaTx.js` can produce: log id `${uid}_${date}`, `userId == uid`, date today or yesterday (IST),
`target` 8..64 and never changed afterwards, `roundsCompleted` an integer 0..64, `completed` = rounds reached the target (16 for admin/folks_head), `streak` at most the profile
streak (+1 on an update), `score <= rounds*2 + (10 + bonus for streak 3/7/30 when completed)` (absolute max 338). A new log must start at 0 rounds / 0 score. An owner's change to the
profile summary (`streak`, `longestStreak`, `score`, `lastSadhanaDate`, `lastCompletedSadhanaDate`) may raise the score by no more than the same-commit log gained, the streak by 1 only
when that log flips to completed, and `longestStreak` only up to the streak. Decreases stay allowed (the client's correct-down flow). Admins/staff editing other members are unchanged;
the client's `MAX_ROUNDS` was lowered from 200 to 64 to match.

## Cross-collection business invariants and who maintains them

These are maintained by clients / handlers, **not by the database**. The typed schema adds natural-key UNIQUEs
(see SCHEMA.md) but, by design, no triggers or generated counters, so every row in this table is still true:

| invariant | maintained by | notes for typed schema |
|---|---|---|
| events.attendingCount/declinedCount == RSVP statuses | client tx `useRsvp.js` (absolute values); policy checks +-1 | add trigger on `registrations` or keep counters + nightly reconcile |
| sevas.countRegistered == #registrations in (registered, completed) | client tx (join/leave/roster cancel), server handlers; policy checks regs flip in same commit (`policies.js:228-235`) | trigger or generated count; max enforced at join (`count >= maxVolunteers` check) |
| trip seats <= capacity | database triggers (migration 003), `trips.seats_taken` | FIXED, see "Trip capacity" |
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
