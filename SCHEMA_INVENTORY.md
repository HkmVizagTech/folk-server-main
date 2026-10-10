# FOLK Vizag: data-model inventory (for a typed Postgres schema)

Scope: every collection read or written by the client (`/Users/giridhar/Developer/folk/folk-client/src`) or the server (`/Users/giridhar/Developer/folk/folk-server-main`). Read-only analysis.

Citation note: the server repo was being refactored into `src/` (controllers, services, db) while this was written. File:line citations for the server use the ORIGINAL layout (`db/policies.js`, `db/dataApi.js`, `db/pgstore.js`, `db/seeds.js`, `db/migrate.js`, `server.js`, `handlers/*`, `services/otpService.js`), which is still in git HEAD. Client paths are relative to `folk-client/src/`.

---------------------------------------------------------------------------
## 0. Cross-cutting facts that drive the schema design

**Current storage** (`db/pgstore.js:4-7, 485-493`): every collection = table `(id text PK, data jsonb, version bigint default 1, created_at timestamptz, updated_at timestamptz)` plus GIN(data) and an index on `data->>'userId'`. Collection names must match `/^[a-z][a-z0-9_]{0,62}$/` (`pgstore.js:17`). Subcollections unsupported.

**Wire contract the client depends on** (must be preserved by any typed layer):
- Browser talks only to `/dbGet`, `/dbQuery`, `/dbCommit`, `/dbChanges` (`db/dataApi.js:115,124,150,228`). Docs come back as `{id, exists, data, v}`; `v` = `"v<version>"` (`dataApi.js:65-70`). `dbCommit` takes `preconditions:[{path,v}]` and aborts with `aborted` if any version changed (client `runTransaction` retries up to 5x, `lib/pgstore.js:301`). So a typed schema MUST keep a per-row `version bigint` that increments on every write.
- Field names are camelCase in documents; a typed schema must serialise columns back to the exact same camelCase keys. Missing optional fields must be omitted or null consistently (client uses `x ?? default` and `x || ''` widely, and `!== undefined` checks in a few places, e.g. `policies.js` `'maxVolunteers' in before`, `after.cashCollected ?? false`).
- **Timestamps**: stored as ISO strings `YYYY-MM-DDTHH:mm:ss.SSSZ`. BOTH client and server revive ANY string matching `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` into a Timestamp object (`lib/pgstore.js` ISO_RE, `db/pgstore.js:18-45`, `dataApi.js:25`). So timestamptz columns must be emitted with exactly millisecond precision and a `Z` suffix. Date-only strings (`'2026-10-10'`) are NOT revived and must stay plain strings (use `date` columns serialised as `YYYY-MM-DD`, or `text`).
- Sentinels sent by the client (`dataApi.js` toBackend): `serverTimestamp`, `increment {n}`, `delete`, `arrayUnion`, `arrayRemove` (the typed layer must implement these per column).
- `set(..., {merge:true})` deep-merges nested maps; `update()` accepts dotted keys. Documents are limited to 900,000 chars JSON (`dataApi.js:107-113`); `dbQuery` is capped at 5000 rows, default limit 5000 (`dataApi.js:23`).
- Query ops allowed from browser: `== != < <= > >= in not-in array-contains array-contains-any`, up to 10 filters, up to 4 orderBys, `__name__` pseudo-field (doc id). Semantics (`pgstore.js` `_sql`): an `orderBy(field)` EXCLUDES docs where that field is missing/null (Firestore behaviour). `==` matches JSON-equality; an absent field never matches `==`.
- Reads are filtered per-document AFTER the query by `canRead` (`policies.js` READ table, `dataApi.js:124-148`). Consequence: a non-staff `list` on `trip_registrations`, `attendance`, `registrations`, etc. silently returns only the caller's rows. (Causes the seat-count bug in §trip_registrations.)
- Change feed: in-memory `{seq, collection}` ring (`dataApi.js` noteChange); client polls `/dbChanges` every 5 s (`lib/pgstore.js:335`) and refetches affected collections. A typed layer must call `db.onWrite({collection,...})` for every write.

**Roles** (`users.role`): `admin` (super), `folks_head` (a "FOLK guide"), `devotee`; client also filters on a `volunteer` role (`features/devotees/lib/levels.js` ROLE_FILTERS) that no server rule knows. Root admin uid constant `wRbvUaFiBOYeXEEtF8OuXnzGWXs2` (`policies.js:12`; also `adminHandler.js` env ROOT_ADMIN_UID).

**IDs**: Firebase Auth UIDs for users (+ `manual_<uuid>` for staff-created profiles with no login); 20-char Firestore-style autoId (`pgstore.js` `autoId()`, charset A-Za-z0-9) for add()/doc(); composites listed per collection. Max doc id length 300.

**Collections that actually exist** (client + server union): `users, events, registrations, attendance, prasadam_logs, sadhana_logs, sevas, seva_registrations, trips, trip_registrations, payments, accommodation_requests, hostel_listings, hostel_bookings, courses, enrollments, followups, notifications, contact_messages, broadcasts` (all browser-reachable per policies) plus server-only `otp_codes, event_secrets, system`. There is NO collection named `counters`, `phone index`, `config`, `admins` or `gallery`; the "phone index" is the field `users.phoneNormalized` plus the marker doc `system/phoneIndex`.

**Server endpoints NOT used by the client** (client never calls them; it writes straight through `/dbCommit`): `createEvent`, `getEvents`, `verifyAttendance`, `submitSadhana`, `getSadhanaMe`, `getSadhanaAdmin`, `createSeva`, `joinSeva`, `cancelSeva`, `getSevas`, `getMySevas`, `getSevaParticipants`, `markSevaAttendance`. Client `callApi` only calls: `sendOtp, verifyOtp, createOrder, paymentConfig, verifyPayment, updateAccommodationStatus, broadcast, createAdmin, deleteUpload, uploadConfig, ping` (grep of `callApi(` in `folk-client/src`). The unused handlers still define shape assumptions that DISAGREE with the client (see §Disagreements); a typed schema must satisfy both shapes or the dead handlers must be deleted/updated.

**Recommended general pattern**: typed columns for everything in this document + one `extra jsonb NOT NULL DEFAULT '{}'` for unknown/legacy keys so unrecognised fields written by the client round-trip (the client spreads whole forms, e.g. `...form` in sevas and accommodation_requests). Keep `version bigint`, and keep doc `createdAt`/`updatedAt` as real columns distinct from row `created_at/updated_at` (migrate.js copies Firestore createTime/updateTime into the row columns, which can differ from the doc field `createdAt`).

---------------------------------------------------------------------------
## 1. users

**Purpose**: member/staff profile, also sadhana aggregate (streak/score) and care/follow-up state.
**Id**: Firebase Auth uid (signed-up), or `manual_<uuid|time-rand>` for staff-added profiles (`features/devotees/hooks/useDevoteeActions.js:36-45`). `doc.id === doc.uid`.
**Writers**: client `context/AuthContext.jsx:172-195` (create profile; qrToken backfill; root-admin self promote), `features/profile/hooks/useProfileForm.js:57` (merge update), `features/devotees/hooks/useDevoteeActions.js` (staff create/update/delete/qrToken), `features/my-members/hooks/useFollowUpLog.js:76` (batch update), `features/sadhana/lib/sadhanaTx.js:70-82` (streak/score). Server: `handlers/adminHandler.js` (createAdmin upsert), `handlers/sadhanaHandler.js:90-96` (unused), `handlers/broadcastHandler.js:106` (phoneNormalized backfill), `handlers/authHandler.js` (onUserCreate, NOT wired in server.js). Readers: nearly every page; server `middlewares/auth.js:10` (role), otpHandler lookups, broadcast, seeds `reportAdmins`.
**Policy** (`policies.js:177-193`): create own doc only with role devotee (root: admin) and without STAFF_MANAGED_FIELDS; staff may create devotee rows; update by owner allowed unless it touches role or STAFF_MANAGED_FIELDS (`stage, level, guideId, guideName, guidePhone, nextFollowUpDate, lastFollowUpAt, lastFollowUpNote`, `policies.js:28`); staff may update devotee rows; delete admin only. Read: own doc or staff (list = any signed-in user, filtered per doc).

| field | type | null/default | notes |
|---|---|---|---|
| uid | text | always (= id) | redundant copy; client queries `where('uid','==',token)` (`verifyEntry.js:36`) |
| name | text | always; default `'Devotee'` | canonical display name |
| fullName, displayName | text | legacy/aliases | read via `u.name \|\| u.fullName \|\| u.displayName \|\| 'Unnamed'` (`hooks/useMembers.js:16`). `displayName` also computed client-side onto member objects; do not store separately unless it already exists |
| email | text | `''` | |
| phone | text | `''` | free text, any Indian format (`+91 98765 43210`, `98765…`) |
| phoneNormalized | text | optional | digits `91XXXXXXXXXX` (`lib/phone.js`, server `otpService.normalizePhone`); used by OTP login lookup, index it |
| photo | text (url or data: URI) | optional | alias `photoURL` (read `user?.photo \|\| user?.photoURL`); form field `profileImage` is written as `photo` (`useProfileForm.js:57`; since the payload is spread, the `profileImage` key is ALSO persisted) |
| profileImage | text | optional | persisted by the spread in useProfileForm.js:57 (duplicate of photo) |
| role | enum `admin \| folks_head \| devotee` (client also lists `volunteer`) | always; default `devotee` | never writable by non-admin except root |
| qrToken | text | optional, unique in practice | formats: `crypto.randomUUID()` (AuthContext) or `FOLK-<id>-<RAND6>` / `FOLK-<base36time>-<RAND6>` (staff). Looked up by `where('qrToken','==',…)` -> unique partial index |
| username | text | optional | only on shared admin account (adminHandler) |
| createdAt, updatedAt | timestamptz | createdAt always for new; updatedAt optional | |
| gender | text | optional | profile options `Male/Female/Other` |
| dob | date `YYYY-MM-DD` string | optional | regex `^\d{4}-\d{2}-\d{2}$` in `my-members/lib/memberMetrics.js:11`; no UI in this client writes it (set by import/staff) |
| occupation, qualification, city, state, country, center, address, fatherName, fatherPhone | text | optional | `address` written by Devotee form (staff) |
| spouseId | text (id of another users row, free text in UI) | optional | soft ref to users, not validated |
| level | text | optional | LEGACY. New values: `FOLK New / FOLK Enhanced / Pre-Initiated / Initiated` (profile/devotee forms); old rows hold numeric strings `'1'..'5'` |
| stage | enum `new \| regular \| practising \| committed \| resident` | optional | NEW canonical (journey). Derivation rule `stageOf`: stage if valid; else map level label (client only: `folk new->new, folk enhanced->regular, pre-initiated->practising, initiated->committed`, `content/journey.js:14-26`); else numeric level 1..5 -> index; else `'new'`. Server `policies.js:21-26` and `broadcastHandler.js` stageOf lack the label mapping (disagreement) |
| guideId | text fk -> users.id (a folks_head/admin) | optional | the member's guide; indexed query `where('guideId','==',uid)` in broadcast; `policies.canSeeEvent` uses it |
| guideName, guidePhone | text | optional denormalised copy of guide | staff-managed |
| assignedGroup | text fk -> users.id | optional, server-only | read only by `accommodationHandler.js` (folks_head may recommend only for users whose assignedGroup == their uid); no client code writes it. Likely legacy of `guideId`; decide mapping |
| nextFollowUpDate | date `YYYY-MM-DD` string | optional/null | compared lexicographically to todayIST (`memberMetrics.js:62`) |
| lastFollowUpAt | timestamptz | optional | client writes a `new Date()` then overwrites with serverTimestamp in the same batch |
| lastFollowUpNote | text (<=200) | optional | |
| streak | int | default 0 | current chain |
| longestStreak | int | optional default 0 | client sadhanaTx only |
| score | int | default 0 | |
| lastSadhanaDate | date string | optional | "last logged anything" (also used as contact gap) |
| lastCompletedSadhanaDate | date string/null | optional | last day target hit (client only) |
| sadhanaTarget | int | optional | read-only fallback in `home/hooks/useHomeData.js:39`; never written |
| metadata | jsonb `{location, source}` | optional | only from dead `authHandler.onUserCreate` |

**Queries**: `getDocs users` full list (staff dashboards, useMembers `useFirestore('users')` no filter); `where qrToken ==`; `where uid ==`; server `where phoneNormalized ==`, `where phone == (phone | +e164 | local10 | '+91 xxxxx xxxxx')`, `.limit(5)`; `where guideId ==`; `where role ==` (admin, folks_head, devotee). Indexes: unique(`qr_token`) where not null; `phone_normalized`; `phone`; `guide_id`; `role`.
**Uniqueness**: id; qrToken. Phone is NOT unique (otpHandler explicitly detects multiple profiles claiming a number and refuses login; keep non-unique). Email not unique-enforced.
**Invariants**: streak/score maintained by `sadhanaTx.js` (client) in a transaction with the log; also by unused server `submitSadhana`. Root admin forced to `role='admin'` client-side on login (`AuthContext.jsx:272-276`).
**Recommendation**: wide typed table; no child tables. `extra jsonb` for leftovers.

---------------------------------------------------------------------------
## 2. events

**Purpose**: programs/calendar entries, public site listing, RSVP counters.
**Id**: autoId (client `addDoc`, server `doc()`).
**Writers**: client `components/events/EventModal.jsx:114-150` (create/update/delete); RSVP counters via `features/events/hooks/useRsvp.js:88-97`. Server `handlers/eventHandler.js` createEvent (unused by client). Readers: events, calendar, landing (public, signed-out), home, attendance scanner, gallery, my-members (`useFirestore('events')` no filter).
**Policy** (`policies.js:131-173`, read `canSeeEvent` 87-96): create = staff; non-admin must set `audience != 'all'` and `ownerId == uid`; delete = admin or owner staff; RSVP path may change ONLY `attendingCount`/`declinedCount` by -1/0/+1 each and >=0 (any signed-in user); guide cannot change ownerId, cannot promote to 'all'. Read visibility by audience (`all` public; `mine` -> owner, members whose guideId == ownerId, admin; `residents` -> stage=='resident' or staff or owner).

| field | type | null/default | notes |
|---|---|---|---|
| title | text | always | |
| category | text | always; client default `'Weekly Program'`; list: Weekly Program, Retreats, Kirtans, Festivals, Yatras, Seminars, Other (`events/lib/events.js`) | free text, do not enum strictly |
| date | text | always | **CLIENT writes a human label** `"Sat, Oct 10, 6:30 PM"` (IST) at `EventModal.jsx:121`; legacy/server `createEvent` writes a raw date string (`optionalString(data.date)`). NOT a parseable date. Treat as text |
| dateISO | timestamptz (ISO string) | always for client-created | machine date; client sorts by `dateISO \|\| date`. Revived as Timestamp |
| time | text | `''` | server createEvent only |
| location | text | `''` | |
| description | text | `''` | |
| img | text (https url or large data: JPEG URI, ~1000px) | `''` | can be hundreds of KB; consider `text` + TOAST |
| audience | enum `all \| mine \| residents` | default `'all'` when missing | |
| ownerId | text fk -> users.id | optional (legacy events have none) | creator guide/admin |
| ownerName | text | optional denormalised | |
| groupId | text | optional; client writes `auth uid` or `'system'`; server createEvent writes `uid` for folks_head only | legacy "group" (= owner uid); unused for access control |
| createdBy | text fk users | server createEvent only | |
| createdAt, updatedAt | timestamptz | | |
| attendingCount, declinedCount | int >=0 | default 0 (events created before counters may lack them; client reads `attendingCount ?? attendees ?? 0`) | maintained by client RSVP tx using ABSOLUTE values (not increment); policy only validates delta in {-1,0,1} |
| attendees | int | legacy | typed by staff at creation in old UI; read fallback only |
| status | text | optional | read only by `attendance/lib/events.js` ("active") to pick the scan event; events never written with it |

**Queries**: always full list `useFirestore('events')` then client filter/sort (no where/orderBy from client). Server: `orderBy('date','asc')` (`eventHandler.js:60`, sorts by the label string = wrong order for client-created events). Indexes: `date_iso`, `owner_id`, `audience`.
**Unique**: none. **Derived**: attending/declined counts = count(registrations where eventId=this and status). Recommend keeping counters as columns (client writes them) AND adding a trigger or a periodic reconcile from `registrations`.
**Nested**: none.

### 2b. event_secrets (server-only)
Id = event id. Fields: `attendanceToken` text (8 hex uppercase, `crypto.randomBytes(4)`), `createdAt` timestamptz. Written ONLY by `eventHandler.createEvent` (batch with the event, `eventHandler.js:45`), read by `attendanceHandler.verifyAttendance:29`. Because the client creates events directly, client-created events have NO event_secrets row, so server self-check-in can never succeed for them (disagreement). Policies: server only (no READ/WRITE entry). Table: `event_id PK/FK events ON DELETE CASCADE, attendance_token text, created_at`.

---------------------------------------------------------------------------
## 3. registrations (event RSVPs)

**Purpose**: a member's RSVP to an event plus the per-RSVP gate token.
**Id**: composite `${eventId}_${userId}` (`useRsvp.js:55`). Mock events (`id.startsWith('mock')`) write a registration with eventId `mock…` and no matching event -> do not enforce FK.
**Writers**: client `useRsvp.js` (set merge, in a tx with events counters). Readers: `useEventsData.js:10`, `home`, `AttendancePage`, scanner (`verifyEntry.js:14` token lookup).
**Policy** (`policies.js:195-200`): create `after.userId == uid`; update staff, or owner not changing userId/eventId; delete admin. Read owner or staff.

| field | type | notes |
|---|---|---|
| eventId | text fk -> events.id (soft) | |
| eventTitle | text | denormalised |
| userId | text fk -> users.id | |
| userName | text | denormalised (`user.name \|\| fullName \|\| auth displayName \|\| 'Devotee'`) |
| token | text/null | 8-char uppercase (`uuidv4().slice(0,8).toUpperCase()`) only when status=Attending, else `null`; looked up by `where('token','==',RAW.toUpperCase())` |
| status | enum `'Attending' \| 'Not Attending' \| 'Cancelled'` (exact casing/spaces, `events/lib/events.js:1-3`) | |
| updatedAt | timestamptz | no createdAt written |

**Queries**: `where userId ==`; `where token ==` (limit none, takes first). Indexes: unique(`event_id,user_id`) (implied by id), `user_id`, unique-ish partial `token` where not null, `event_id`.
**Invariant**: moving status adjusts events.attendingCount/declinedCount by exactly one (COUNTER_FIELD; `Cancelled` counts in neither).

---------------------------------------------------------------------------
## 4. attendance

**Purpose**: one check-in per user per event. "Absent" = no row (roll-call untick DELETES the doc, `useRollCall.js`).
**Id**: composite `${eventId}_${userId}` — used by roll call (`useRollCall.js:65`), QR scanner (`ScanningOverlay.jsx:98`, `verifyEntry.js:77`), and server self check-in (`attendanceHandler.js:37`, uses `create()` to dedupe).
**Writers**: staff client (roll call `setDoc`, scanner tx) ; server `verifyAttendance` (bypasses policy, `policies.js:210` says staff-only). Readers: Attendance page, profile, sadhana page, my-members, reports.

| field | type | notes |
|---|---|---|
| userId | text fk users | always (server also writes `uid` copy) |
| uid | text | server self-check-in only; client reads `a.userId \|\| a.uid` (`useRollCall.js`) |
| name | text | denormalised; **missing on server self-check-in rows** |
| eventId | text fk events | |
| session | text | event title denormalised (`eventTitle` fallback read in profile ActivityTabs) ; missing on server rows |
| status | text | client `'On-time'` (counted by `AttendancePage` `status === 'On-time'`); server writes `'present'` (never matches). Treat as text, not enum |
| method | text | `'roll-call'` (client) / `'self-check-in'` (server); scanner rows have none |
| markedBy, markedByName | text | roll-call only |
| time | text | locale clock string e.g. `06:30 PM` / `18:30` (not parseable; display only) |
| createdAt | timestamptz | primary sort/range field |
| timestamp | timestamptz | server rows only (duplicate of createdAt); `memberMetrics.js:37` reads `createdAt \|\| timestamp` |

**Queries**: full list (`AttendancePage`); `where eventId ==` (roll call); `where userId ==` (profile, sadhana page sorts client-side); `orderBy createdAt desc limit 1500` (my-members); `where createdAt >= since, orderBy createdAt desc` (reports `useReportStats.js:17`). Indexes: unique(`event_id,user_id`); `user_id`; `created_at desc`.
**Unique**: (eventId,userId). Delete is part of the workflow, so do not turn it into a soft status.

### 4b. prasadam_logs
Same pattern. **Id** `${eventId}_${userId}`. Writer: scanner only (`ScanningOverlay.jsx:138`, `verifyEntry.js` MODES.prasadam), staff-only policy (`policies.js:211`, delete admin only). Fields: `userId`, `name`, `eventId`, `eventTitle`, `received: true`, `timestamp` timestamptz (note: `timestamp`, NOT createdAt). Read by `sadhana/lib/fetchSadhana.js:recent('prasadam_logs','timestamp')`. Unique (eventId,userId); index `user_id`.

---------------------------------------------------------------------------
## 5. sadhana_logs

**Purpose**: daily chanting log; one per user per IST calendar day.
**Id**: composite `${uid}_${YYYY-MM-DD}` (IST date) (`sadhanaTx.js:10,33`; server `sadhanaHandler.js:31`).
**Writers**: client `sadhanaTx.js` two-step: `createTargetTx` (set `status:'locked'`, rounds 0) then `logRoundsTx` (update, may be called repeatedly to correct); unused server `submitSadhana` (single shot). Readers: `home/useHomeData.js:18`, `sadhana/fetchSadhana.js`, server `getSadhanaMe`.
**Policy** (`policies.js:202-208`): ANY write requires only `after.userId == uid` (no validation of score/streak/rounds; delete admin). Note this lets a client forge score.

| field | type | notes |
|---|---|---|
| userId | text fk users | |
| date | date `YYYY-MM-DD` (IST) | string, ordered desc lexicographically |
| userName | text | server only |
| target | int | client: member-chosen vow (admin/folks_head forced to 16); server constant 16 |
| roundsCompleted | int 0..64 | |
| progressPercentage | int 0..100 | `min(100, round(rounds/target*100))` |
| streak | int | snapshot of streak after this log |
| score | int | log score. Client formula `rounds*2 (+10 if rounds>=target) + bonus at streak 3:+20, 7:+50, 30:+200 unless in bonusClaimed`; server formula `0 if <16; else 10 + 2*(rounds-16) + (streak==3:+20, ==7:+50)` — DIFFERENT |
| status | text `'locked'` | client create only, never changed afterwards |
| completed | boolean | client logRounds only |
| bonusClaimed | int[] | READ by client (`!old.bonusClaimed?.includes(day)`) but never written anywhere -> always absent |
| createdAt | timestamptz | |
| updatedAt | timestamptz | client logRounds only |

**Queries**: `where userId == AND date == today` (home); `where userId == orderBy date desc limit 7` (needs composite index; client has a fallback path on `failed-precondition` that drops the orderBy); `where userId ==` (server). Indexes: unique(user_id, date) (== id); `(user_id, date desc)`.
**Invariants** (transactional with users row): users.streak, longestStreak, score (`score += logScore - old.score`, never <0), lastSadhanaDate, lastCompletedSadhanaDate. Streak resets to 0 unless lastCompleted is today or yesterday (`sadhana/lib/streak.js`).

---------------------------------------------------------------------------
## 6. sevas, seva_registrations

### sevas
**Id**: autoId. **Writers**: client `seva/hooks/useSevaForm.js:23` (`setDoc(doc(collection))`, spreads whole form), server `createSeva` (unused). **Counter writers**: client `useSevas.js` join/leave tx, `useVolunteers.js` cancel tx, server join/cancel/markAttendance (unused).
**Policy** (`policies.js:220-236`): create staff; staff update anything; any signed-in user may change ONLY `countRegistered` by +1 (and seva_registrations/{uid}_{id} goes unregistered->registered in the same commit) or -1 (registered->not), within `maxVolunteers`; delete admin. Read: any signed-in.

| field | type | notes |
|---|---|---|
| title, description | text | |
| sevaType | text; values cleaning, cooking, organizing, reception, distribution, other | |
| date | date string `YYYY-MM-DD` | rendered with `new Date(date)` in UTC |
| time | text | free (`'18:30'`) |
| location | text | |
| maxVolunteers | int >=1 (<=10000 server) | |
| isRecurring | boolean | |
| countRegistered | int >=0 | **counter**: seats held. Statuses `registered` and `completed` hold a seat; `cancelled` frees one (server `markAttendance`). Client roster cancel of a `completed` registration does NOT decrement (disagreement) |
| createdBy | fk users | |
| createdAt | timestamptz | |

Queries: full list; server `orderBy date asc`. Index `date`.

### seva_registrations
**Id**: `${userId}_${sevaId}` (policy enforces exactly this on create: `policies.js:241`). **Policy**: create own, `status=='registered'`; staff update; owner may flip registered/cancelled unless `completed`; delete denied for everyone (`!signedIn || type==='delete'` -> false).
Fields: `userId` fk, `sevaId` fk, `sevaTitle` (denormalised, client only), `userName`, `userPhone` (client only; server join omits them), `status` enum `registered | cancelled | completed`, `createdAt`, `updatedAt`.
Queries: `where userId ==` (my regs), `where sevaId ==` (roster, also server getSevaParticipants). Indexes: unique(user_id,seva_id), `seva_id`, `user_id`.
**Re-join**: row is overwritten (set) when status was cancelled; createdAt resets.

---------------------------------------------------------------------------
## 7. trips

**Purpose**: yatras (public listing + booking). **Id**: autoId; business key `slug` (unique, `/^[a-z0-9][a-z0-9-]*$/`, enforced only client-side `trips-admin/lib/tripForm.js:validateTrip`; seed also dedupes by slug `seeds.js:18`).
**Writers**: client `trips-admin/hooks/useTripForm.js:82-90`, `useTripActions.js` (status/registrationOpen patches), `useDeleteTrip.js`; server `db/seeds.js` (srikurmam seed, `createdBy:'seed'`). **Policy**: read public (anyone, signed out); write staff only (`policies.js:284`).

| field | type | null/default | notes |
|---|---|---|---|
| slug | text UNIQUE | always | |
| title | text | always | |
| subtitle, location, description, durationLabel, meetingPoint, contactPhone | text | `''` | description may contain `\n\n` paragraphs |
| coverImage | text | `''` | https R2 URL or legacy data: URI |
| gallery | text[] (jsonb array of urls, max 3) | `[]` | |
| startDate, endDate | date `YYYY-MM-DD` | required by form | lexicographic compare in client (`startDate`/`endDate`), `endDate >= startDate` |
| price | numeric rupees (INR, not paise) | number; `toNumber` | per-seat price |
| originalPrice | numeric rupees | optional | shown struck through |
| advanceAmount | numeric rupees | 0 = none | server: `payNow = advance>0 ? min(advance*seats,total) : price*seats`; validated `advance <= price` client-side |
| capacity | int | 0/null = unlimited | |
| eligibility | text | `''` | e.g. `'Boys only'`, `'Girls only'` |
| status | enum `draft \| upcoming \| ongoing \| completed \| cancelled` | default `draft` | |
| registrationOpen | boolean | default false | |
| onlinePaymentEnabled | boolean | default TRUE when absent (`!== false`) | |
| cashPaymentEnabled | boolean | default FALSE when absent (`=== true`) | |
| highlights, inclusions, exclusions | text[] | `[]` | trimmed non-empty strings |
| itinerary | jsonb array `[{day:int, title, details}]` | `[]` | |
| locations | jsonb array `[{id:text, name, description, image}]` | `[]` | ids are uuid or `loc-N`; client treats as ordered list with stable ids |
| createdBy | text | uid or `'system'` / `'seed'` | |
| createdAt, updatedAt | timestamptz | | |

**Queries**: `where slug == ` (detail page); full list. Index unique `slug`; `start_date`.
**Nested recommendation**: keep `itinerary`, `locations`, `gallery`, `highlights`, `inclusions`, `exclusions` as jsonb/text[] (always read and written whole with the trip form; never queried). `locations[].id` is only a React key.
**Business invariant**: capacity vs seats. NOT enforced server-side anywhere; computed on the client from `trip_registrations` (see below).

---------------------------------------------------------------------------
## 8. trip_registrations

**Purpose**: a seat booking; also holds payment intent and cash attestation.
**Id**: autoId (client `addDoc`). Natural business rule: one LIVE (non-cancelled) registration per (tripId,userId) — enforced only in UI (`myRegistration` picks first non-cancelled) -> add partial unique index `WHERE status <> 'cancelled'`? Careful: statuses are matched case-insensitively in client (`(r.status||'').toLowerCase()`), so store lower-case.
**Writers**: client create `trip-detail/hooks/useBookingActions.js:27-43`; owner updates `travellers/emergencyContact/pickup/travellerNotes` (`useTravellerDetails.js:30`); owner cancel (`status:'cancelled'` from pending only, `useBookingActions.js:149`); owner sets `paymentOrderId` (`:112`); staff `status/staffNotes` (`trips-admin/hooks/useRegistrationActions.js`), cash fields (`useCashRecording.js:40,62`). Server: `paymentHandler.createOrder:~117` (sets paymentOrderId + updatedAt), `confirmTripSeat` (`status:'confirmed', confirmedBy:'payment'`).
**Policy** (`policies.js:289-335`): create requires `userId==uid, status=='pending', seats integer 1..20, cashCollected falsy, no cashAmount/cashCollectedAt/cashCollectedBy, paymentOrderId null`. Staff update only TRIP_STAFF_FIELDS (`status, staffNotes, updatedAt, cashCollected, cashAmount, cashCollectedAt, cashCollectedBy`). Owner update: details fields only (not if cancelled; `travellers.length <= seats` AND each `validTraveller`; `emergencyContact<=120`, `pickup<=120`, `travellerNotes<=500`), or `paymentOrderId` pointing at a payments doc owned by the user with matching `tripRegistrationId`, or pending->cancelled. Delete admin.

| field | type | notes |
|---|---|---|
| tripId | text fk trips.id | |
| tripSlug, tripTitle | text | denormalised |
| userId | text fk users | |
| userName, userPhone, userEmail | text | denormalised, as typed in the booking form (searchable by staff) |
| seats | int 1..20 | |
| amountDue | numeric rupees | = `price*seats` computed client-side at booking (`pricing.total`), NOT payNow |
| paymentMode | enum `online \| cash` | declared intent |
| paymentOrderId | text/null fk payments.id | Razorpay order id; null at creation |
| status | enum `pending \| confirmed \| waitlisted \| cancelled` | always lower-case written; compared lower-cased |
| confirmedBy | text | server only (`'payment'`) |
| staffNotes | text | `''` default |
| cashCollected | boolean | absent == false |
| cashAmount | numeric rupees | |
| cashCollectedAt | timestamptz | |
| cashCollectedBy | text | uid, or name/`'staff'` fallback (not always a uid) |
| travellers | jsonb array of objects | see below |
| emergencyContact | text <=120 | |
| pickup | text <=120 | "boarding point" |
| travellerNotes | text <=500 | also set at creation from form |
| createdAt, updatedAt | timestamptz | |

`travellers[]` item (validated by `policies.validTraveller`): `{name<=80, age:number 1..120|null, gender:'Male'|'Female'|'' (policy allows <=20 chars), idType: one of aadhaar|pan|passport|voter|driving|student|other|'', idNumber<=40, relation<=40 (policy only), college<=120, course<=80, year<=24 ('1st year'…'Postgraduate','Working','Other')}`. Client always sends the 8 fields name, age, gender, idType, idNumber, college, course, year. **Recommend jsonb** (variable length bounded by seats, always edited as a whole list, read as a whole by the admin export; per-traveller querying is not needed). A normalised `trip_registration_travellers` child table is possible but then the API layer must re-assemble the array in order; only worth it if staff want SQL on colleges.

**Queries**: `where userId ==` (devotee); `where tripId ==` (staff on trip page); unfiltered full list (staff `useTripsData`, admin dashboard, and non-staff `trips/useTripsData` uses `where userId==`). Indexes: `user_id`, `trip_id`, `(trip_id,status)`, `payment_order_id`.
**Invariant (BROKEN as built)**: `seatsLeft = capacity - sum(seats of pending|confirmed regs)` is computed in the browser from the rows the caller can READ. Devotees can only read their own registrations (ownerOrStaff, `policies.js:116`), so the displayed "seats left" for a devotee ignores everyone else's bookings (`useTripDetailData.js:38-48`, `trips/hooks/useTripsData.js:31-40`). No server transaction checks capacity. Recommend: a SQL-side seat counter (view or trigger-maintained `trips.seats_taken`) exposed as a readable field, and a capacity check at insert inside the same transaction.
**Payment settled truth**: online -> `payments/{paymentOrderId}.status=='completed' && verified===true`; cash -> `cashCollected===true` (`trips-admin/lib/payments.js`, `useTripDetailData.js:62-70`).

---------------------------------------------------------------------------
## 9. payments

**Purpose**: Razorpay order ledger (trip seats and free-form donations). Server-written only (no WRITE entry in policies); owner/staff read.
**Id**: Razorpay order id (`order_XXXXXXXX`), `paymentHandler.js:109` (`doc(order.id).set`). A client may find it by `p.id`; the client ALSO checks non-existent aliases `p.orderId` / `p.razorpayOrderId` (`useTripDetailData.js:60`, `trips-admin/lib/payments.js:22-23`) which the server never writes.
**Writers**: `paymentHandler.createOrder`, `verifyPayment` (merge), `razorpayWebhook` (transaction; merge). Readers: profile (`where userId ==`), trip detail (`where userId ==`), trips-admin (full list).

| field | type | notes |
|---|---|---|
| userId | text fk users | |
| amount | numeric rupees (INR, can be fractional in principle; `toPaise = round(inr*100)`) | |
| amountPaise | bigint | authoritative for matching Razorpay; legacy rows may lack it (server recomputes) |
| currency | text `'INR'` | |
| purpose | enum `trip \| donation` | legacy rows may lack it |
| tripId | text fk trips (when purpose=trip) | |
| tripRegistrationId | text fk trip_registrations | |
| eventId | text | `eventId || tripId || null` — misnamed; for trips it holds the TRIP id; donations pass an event id or null. No FK |
| status | enum `pending \| completed \| failed \| amount_mismatch` | |
| verified | boolean | |
| paymentId | text | Razorpay payment id |
| method | text/null | card/upi/etc. |
| verifiedBy | text `'checkout'` | set by verifyPayment only |
| capturedAt, failedAt | timestamptz | |
| failureReason | text | |
| lastFailedAttempt | jsonb `{paymentId, reason}` | |
| paidAmountPaise | bigint/null | mismatch cases |
| paidCurrency | text | mismatch (webhook) |
| createdAt | timestamptz | |

Queries: `where userId ==`; full list. Indexes `user_id`, `trip_registration_id`, `status`. Money: keep BOTH `amount numeric(12,2)` and `amount_paise bigint`.
**Invariant**: confirmTripSeat (pending -> confirmed) inside tx after a verified capture; webhook never downgrades a completed payment on a later failure.

---------------------------------------------------------------------------
## 10. accommodation_requests

**Id**: autoId. **Writers**: client create `accommodation/hooks/useRequestForm.js:37` (policy: create only own + signedIn; no client updates); status updates ONLY via server `accommodationHandler.updateAccommodationStatus` (`updatedAt` set). Readers: accommodation page, admin dashboard, scanner (`findApprovedStay`).
Fields: `type` text (`Individual Guest House | Dormitory Bed | Family Apartment | Volunteer Quarters`), `guestCount` int>=1, `arrivalDate` date string, `departureDate` date string (>= arrival), `requirements` text, `userId` fk, `userName` denorm, `status` enum `pending | recommended | approved | rejected` (folks_head may only set `recommended`; admin approve/reject; folks_head restricted to users whose `assignedGroup == their uid`), `createdAt`, `updatedAt`.
Queries: `orderBy createdAt desc` (staff); `where userId == + orderBy createdAt desc`; `where status == 'pending'` (admin dashboard); `where userId == AND status == 'approved'` (scanner). Indexes: `(user_id, created_at desc)`, `status`, `(user_id,status)`.
Side effect: WhatsApp template to `users.phone` (Gupshup) — nothing persisted.

---------------------------------------------------------------------------
## 11. hostel_listings / hostel_bookings

### hostel_listings
Id autoId. Public read (`policies.js:102`), staff write. Fields: `name`, `description`, `capacity` int (default 1), `amenities` text[] (comma list in UI), `img` text (data: URI <=800px), `active` boolean (absent = true, `active !== false`), `createdBy`, `createdAt`. Edits write `listingPayload` (name, description, capacity, amenities, img) only. No queries beyond full list.

### hostel_bookings
Id autoId. Create own `status=='pending'`; staff may change only `status, staffNotes, updatedAt`; owner may cancel only while pending (`status,updatedAt`) (`policies.js:251-259`). Fields: `listingId` fk, `listingName` denorm, `userId` fk, `userName` denorm, `checkIn`, `checkOut` date strings (checkOut>=checkIn), `guestCount` int>=1, `notes` text, `status` enum `pending | approved | rejected | cancelled` (compared lower-cased), `staffNotes` (policy-allowed; UI mostly doesn't set it), `createdAt`, `updatedAt`. Queries: `orderBy createdAt desc` (staff), `where userId == + orderBy createdAt desc`. Indexes `(user_id, created_at desc)`, `listing_id`, `status`.

---------------------------------------------------------------------------
## 12. courses / enrollments

### courses
Id autoId. Read: any signed-in (client hides `active===false` from members). Write staff (delete admin). Fields: `title`, `description`, `sessions` int 1..100, `schedule` text, `active` boolean (absent = true), `createdAt`, `createdBy`, `updatedAt`.

### enrollments
**Id**: composite `${courseId}_${userId}` (policy-enforced on create `policies.js:270-275`). Create: own, `status=='enrolled'`, `sessionsAttended===0`; update staff only; delete admin. Fields: `courseId` fk, `courseTitle` denorm, `userId` fk, `userName`, `userPhone` denorm, `status` enum `enrolled | completed`, `sessionsAttended` int, `createdAt`, `updatedAt`. **Invariant**: `status = sessionsAttended >= course.sessions ? 'completed' : 'enrolled'`, updated by roster `increment(delta)` (`courses/hooks/useRoster.js`). Queries: `where userId ==`, `where courseId ==`. Indexes: unique(course_id,user_id), `user_id`.

---------------------------------------------------------------------------
## 13. followups

Guide care log. **Id**: autoId (written with `batch.set(doc(collection))`) together with a `users` update in one batch (`useFollowUpLog.js:65-76`). Create: staff, `guideId==uid`, `note` string <=1500; update/delete: admin or the creating guide. Read staff only.
Fields: `memberId` fk users, `memberName` denorm, `guideId` fk users, `guideName` denorm, `channel` text (`'Call'` default; other options in UI), `note` text<=1500, `nextDate` date string or null, `createdAt` timestamptz.
Queries: `where memberId ==` (history modal), `where createdAt >= since` (reports). Indexes `member_id`, `created_at`, `guide_id`.
Invariant: users.{lastFollowUpAt,lastFollowUpNote(<=200),nextFollowUpDate,(stage)} mirror the latest log (denormalised summary).

---------------------------------------------------------------------------
## 14. notifications / contact_messages / broadcasts

### notifications
Autoid. Create staff (client creates on new public event, new seva, new hostel booking — note a devotee creating a hostel booking writes a notification, but policy says create = staff only, so that best-effort write fails for devotees; swallowed by try/catch), delete admin. Read any signed-in. Fields: `type` text (`new_event | new_seva | new_hostel_booking`), `title`, `message`, `link` (`/events`, `/sevas`, `/hostels`), `createdAt`, `createdBy`. Queries: `orderBy createdAt desc limit 10 / limit 100`. Index `created_at desc`. No per-user read state (unread is a localStorage timestamp).

### contact_messages
Autoid. Create own (`userId==uid, status=='new', message<=2000`); update staff; delete admin; read staff only. Fields: `userId`, `name`, `phone`, `email`, `topic` text, `message` text, `status` text (`new` + staff values), `createdAt`. No client query besides staff list.

### broadcasts (server-only writes)
Autoid, `broadcastHandler.broadcast:80`. Fields: `byUid`, `byName`, `audience` jsonb `{type:'mine'|'all'|'stage', stage?}`, `templateId` text, `params` text[] (<=10 x <=200), `total`, `sent`, `failed` int, `createdAt`. Read staff.

---------------------------------------------------------------------------
## 15. Server-only collections

| collection | id | fields | writers/readers |
|---|---|---|---|
| otp_codes | normalised phone `91XXXXXXXXXX` | `codeHash` text (sha256 of `phone:code`), legacy `code` (deleted on write), `phone`, `createdAt` ts, `expiresAt` ts (now+5min), `attempts` int (max 5), `sends` jsonb/bigint[] of epoch-ms numbers (rolling 24h; <=3 per 10 min, <=10/day, >=60s apart) | `services/otpService.js:134-215`. Transactional. History must survive code clearing (`clearedCodeFields` keeps `sends`) |
| event_secrets | event id | `attendanceToken`, `createdAt` | §2b |
| system | `migration` / `seeds` / `phoneIndex` | migration: `source, projectId, counts{}, firestoreLocked, durationMs, completedAt`; seeds: `done: text[]`, `updatedAt`; phoneIndex: `version int, scanned, updated, builtAt` | `db/migrate.js:101`, `db/seeds.js:94`, `broadcastHandler.js:120` |

Not collections: rate limits (in-memory Maps in `server.js` and `adminHandler.js`, not persisted), uploads (Cloudflare R2, no DB), `ROOT_ADMIN_UID` env/const.
Phone "index" = `users.phoneNormalized` (+ `system/phoneIndex` marker). With typed columns, replace with a real index on `users.phone_normalized`.

---------------------------------------------------------------------------
## 16. Where data-shape assumptions disagree (client vs server vs policies)

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

---------------------------------------------------------------------------
## 17. Cross-collection business invariants and who maintains them

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

---------------------------------------------------------------------------
## 18. Summary table

| collection | id format | fk list (soft; do NOT hard-enforce those marked *) | unique keys | recommended indexes |
|---|---|---|---|---|
| users | Firebase uid / `manual_<uuid>` | guideId->users, assignedGroup->users, spouseId->users* | id; qrToken (partial, non-null) | phone_normalized; phone; guide_id; role; qr_token |
| events | autoId | ownerId->users, createdBy->users | id | date_iso; owner_id; audience |
| event_secrets | event id | event_id->events (cascade) | id | - |
| registrations | `{eventId}_{userId}` | eventId->events*(mock ids), userId->users | (event_id,user_id); token (partial) | user_id; event_id; token |
| attendance | `{eventId}_{userId}` | eventId->events*, userId->users* | (event_id,user_id) | user_id; event_id; created_at desc |
| prasadam_logs | `{eventId}_{userId}` | eventId, userId* | (event_id,user_id) | user_id |
| sadhana_logs | `{uid}_{YYYY-MM-DD IST}` | userId->users | (user_id,date) | (user_id,date desc) |
| sevas | autoId | createdBy->users | id | date |
| seva_registrations | `{userId}_{sevaId}` | sevaId->sevas*, userId->users | (user_id,seva_id) | seva_id; user_id |
| trips | autoId | createdBy | slug | slug (unique); start_date |
| trip_registrations | autoId | tripId->trips, userId->users, paymentOrderId->payments | one live reg per (trip,user) (UI rule only) | user_id; trip_id; (trip_id,status); payment_order_id |
| payments | Razorpay order id | userId->users, tripId->trips, tripRegistrationId->trip_registrations, eventId (no FK) | id | user_id; trip_registration_id; status |
| accommodation_requests | autoId | userId->users | id | (user_id,created_at desc); status; (user_id,status) |
| hostel_listings | autoId | createdBy | id | - |
| hostel_bookings | autoId | listingId->hostel_listings, userId->users | id | (user_id,created_at desc); listing_id; status |
| courses | autoId | createdBy | id | - |
| enrollments | `{courseId}_{userId}` | courseId->courses, userId->users | (course_id,user_id) | user_id; course_id |
| followups | autoId | memberId->users, guideId->users | id | member_id; guide_id; created_at |
| notifications | autoId | createdBy | id | created_at desc |
| contact_messages | autoId | userId->users | id | created_at |
| broadcasts | autoId | byUid->users | id | created_at |
| otp_codes | normalised phone `91XXXXXXXXXX` | - | id | expires_at (cleanup) |
| system | `migration` / `seeds` / `phoneIndex` | - | id | - |

Design guidance recap: (a) soft references everywhere users/events can be a `manual_`/`mock` id or have been deleted; (b) arrays of scalars -> `text[]`/jsonb (gallery, highlights, inclusions, exclusions, amenities, params, done); arrays of objects -> jsonb (travellers, itinerary, locations, audience); (c) keep composite string ids as the PK text and add the natural unique constraints on the parts; (d) store dates `YYYY-MM-DD` as `date` columns but serialise as plain strings, store instants as `timestamptz` serialised `toISOString()`; (e) preserve unknown legacy keys in `extra jsonb`; (f) keep `version`; (g) rupee amounts in `numeric(12,2)`, paise in `bigint`.
