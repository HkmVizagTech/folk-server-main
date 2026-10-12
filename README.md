# FOLK Vizag Server

Backend API for the FOLK Vizag devotee app (Node 20, CommonJS, Express 5). It
talks to Firebase Auth, Postgres (or Firestore), Razorpay, Cloudflare R2 and
WhatsApp providers (Gupshup, Flaxxa WAPI).

The client calls every function as `POST /<name>` with a Firebase-onCall style
body `{ "data": {...} }` and receives `{ "result": ... }`; errors come back as
`{ "error": { "message", "status", "code?" } }`. Bearer token = Firebase ID token.

## Run

```bash
npm ci
cp .env.example .env.local   # then fill in; `npm run dev` loads .env.local automatically
npm run dev                  # node --watch, with .env.local loaded
npm start                 # production
npm run lint
npm test                  # node:test suites; starts a throwaway Postgres (see below)
npm run migrate           # apply pending schema migrations by hand (the server also does it on start)
```

The server boots without any credentials (so `/health` and `/ping` work); calls
that need Firebase, Postgres or a provider fail until it is configured.
Docker: `docker build -t folk-server . && docker run -p 8080:8080 --env-file .env folk-server`.

## Folder structure

```
src/
  server.js        bootstrap: listen, seeds, phone index, graceful shutdown
  app.js           Express assembly: CORS, JSON body (+ raw body for webhook), routes, 404, error handler
  config/          env.js (only reader of process.env, frozen), firebase.js, cors.js
  routes/          one file per domain, mounted by routes/index.js
  controllers/     thin: validate input, call a service, shape output
  services/        business logic (payment, razorpayWebhook, upload, admin, otp, phoneAuth,
                   broadcast, sadhana, seva, notification, database)
  middlewares/     auth (token + role guards), rateLimit, onCall adapter, waitForDb, notFound, errorHandler
  db/              Postgres layer with the Firestore API on TYPED tables:
                   pgstore.js (facade), store/ (codec, query builder, writes, transactions, importer, change feed),
                   schema/ (one declarative file per collection), migrations/ + migrator.js, rollback.js,
                   dataApi, policies, migrate (Firestore copy), seeds
  utils/           logger, errors (HttpsError), ids, phone, crypto, asyncHandler
scripts/           debug.js (npm run debug), migrate.js (npm run migrate), rollback-typed.js, gen-schema-sql.js
test/              node:test suites (store, migration, rollback, migrator, schema, seeds, HTTP)
docs/              SCHEMA.md (ER diagram, tables, FK rationale), MIGRATIONS.md (deploy, rollback), KNOWN_ISSUES.md
```

## Database

Every collection is a typed Postgres table (columns per document field, `extra jsonb` for anything else so
documents round-trip exactly, `version`, `created_at`, `updated_at`); see `docs/SCHEMA.md`. Schema changes are
versioned SQL files in `src/db/migrations`, applied automatically on start (advisory-locked, transactional,
recorded in `schema_migrations`); the first one converts the old generic JSON tables, keeping them as
`legacy_<name>`. Deployment and rollback: `docs/MIGRATIONS.md`. Known client/server disagreements that were
deliberately left as they are: `docs/KNOWN_ISSUES.md`.

### Tests

`npm test` needs Postgres. Either set `TEST_DATABASE_URL=postgres://user@host:port` (a fresh `folk_test_*` database
is created and dropped per test file; nothing else is touched), or leave it unset and the tests start (and delete)
a private cluster with `initdb` from `PG_BIN`, `/Library/PostgreSQL/*/bin` or your `PATH`.

## Environment variables

All are read in `src/config/env.js`. See `.env.example` for comments.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port (default 8080) |
| `NODE_ENV` | `development` returns the OTP in `sendOtp` when no WhatsApp provider is set; never use in production |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist; unset = any origin |
| `SERVICE_ACCOUNT_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` | Firebase Admin credentials (inline JSON, or key file path; falls back to `/etc/secrets/serviceAccountKey.json`, then ADC) |
| `DATABASE_URL`, `DATA_BACKEND` | Postgres when set (unless `DATA_BACKEND=firestore`); otherwise Firestore |
| `PG_POOL_MAX`, `DB_AUTO_MIGRATE` | Postgres connections to hold (default 10); set `DB_AUTO_MIGRATE=false` to run `npm run migrate` yourself instead of migrating on start |
| `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`, `ROOT_ADMIN_UID`, `ADMIN_SETUP_CODE` | Shared admin login (`/createAdmin`) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payments |
| `WAPI_TOKEN` (or `FLAXXA_API_KEY`), `WAPI_OTP_TEMPLATE_NAME`, `WAPI_TEMPLATE_LANG`, `WAPI_BASE` | WhatsApp OTP login |
| `GUPSHUP_API_KEY`, `GUPSHUP_SOURCE`, `GUPSHUP_APP_NAME`, `GUPSHUP_TEMPLATE_ACCOMMODATION_ID` | WhatsApp template messages |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | Image uploads |

## Endpoints

Auth: "public" needs no token; "user" any signed-in member; "staff" admin or folks_head; "admin" admin only.
Rate limits are per IP (in-memory sliding window).

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/`, `/health` | public | health returns `{status, uptime, db}` |
| ANY | `/ping` | public | |
| POST | `/dbGet`, `/dbQuery` | per policy | 6000 / 15 min |
| POST | `/dbCommit` | per policy | 1500 / 15 min |
| POST | `/dbChanges` | per policy | 4000 / 15 min |
| POST | `/dbStatus` | admin | |
| POST | `/dbCopyFromFirestore` | admin | 5 / hour |
| POST | `/createEvent` | staff | |
| POST | `/getEvents` | public | |
| POST | `/verifyAttendance` | user | |
| POST | `/updateAccommodationStatus` | staff | |
| POST | `/submitSadhana`, `/getSadhanaMe` | user | |
| POST | `/getSadhanaAdmin` | staff | |
| POST | `/createSeva`, `/getSevaParticipants`, `/markSevaAttendance` | staff | |
| POST | `/joinSeva`, `/cancelSeva`, `/getSevas`, `/getMySevas` | user | |
| POST | `/createOrder` | user | |
| POST | `/paymentConfig` | public | |
| POST | `/verifyPayment` | user | 60 / 15 min |
| POST | `/razorpayWebhook` | HMAC signature | raw body |
| POST | `/uploadImage?folder=` | staff (user for `avatar`) | raw image body, 8 MB; 300 / 15 min |
| POST | `/deleteUpload` | user (own avatar) / staff | 300 / 15 min |
| POST | `/uploadConfig` | user | |
| POST | `/createAdmin` | admin / root / setup code | 20 / 15 min |
| POST | `/sendOtp` | public | 30 / 15 min |
| POST | `/verifyOtp` | public | 100 / 15 min |
| POST | `/broadcast` | staff | 20 / hour |
| POST | `/backfillPhoneIndex` | admin | 5 / hour |
| POST | `/notify` | admin | plain JSON body `{phone, templateId, params}` |
