# Migrations, deployment and rollback

## How migrations work

* Files live in `src/db/migrations/NNN_name.sql` (plain SQL) or `NNN_name.js` (`module.exports = { up(client, ctx) }`).
  They are applied in version order, each in **one transaction**, and recorded in `schema_migrations`
  (`version, name, checksum, applied_at, duration_ms, details`).
* The runner (`src/db/migrator.js`) holds a Postgres **advisory lock** for the whole run, so two replicas (or a script
  plus the server) starting together take turns; the second finds nothing pending. A failing migration rolls back
  completely, is reported by file name, and is retried on the next start. An applied file that was edited later is
  flagged in the log (checksum), never re-run.
* The server runs pending migrations on start (`src/services/database.service.js`, before the one-time Firestore
  copy). POST requests are answered `503 "The database is being set up"` until that finishes; `GET /health` answers
  immediately. Set `DB_AUTO_MIGRATE=false` to skip this and run migrations yourself.
* By hand: `DATABASE_URL=postgres://... npm run migrate` (apply) and `npm run migrate -- --status` (list).
* To add a migration: write `NNN_what.sql`, update the matching `src/db/schema/<collection>.js`
  (`test/schema.test.js` fails if the database and the schema files disagree), and use
  `node scripts/gen-schema-sql.js <collection>` to print DDL for a new table. Never edit an applied migration.

### What the two shipped migrations do

1. **`001_typed_schema.sql`**
   * Finds every legacy generic table `(id, data, version, created_at, updated_at)` and **renames** it to
     `legacy_<name>` (its constraints and indexes get the `legacy_` prefix too, so the new tables can use the
     natural names). Legacy tables are **never dropped**.
   * Creates the 23 typed tables with their CHECKs, UNIQUEs, indexes, the single FK and column comments
     (`COMMENT ON COLUMN ... 'document field "..."'`), plus `docs_other` and `migration_rejects`.
2. **`002_import_legacy_documents.js`** copies every document of every `legacy_<name>` table into its typed table
   (collections outside the registry go to `docs_other`), keeping `id`, `version`, `created_at`, `updated_at`
   (a Firestore-copied row stays at `version 0`). Read-only on the legacy tables; then `ANALYZE`.

On a fresh database (no legacy tables) both are effectively just "create the schema".

### Dirty legacy data never fails the migration

The importer (`src/db/store/importer.js`) handles each problem locally and counts it:

| situation | what happens | where it is reported |
| --- | --- | --- |
| a value does not fit its column (`seats: "3"`, unknown enum value, `dob: "2000-02-30"`, an amount with 3 decimals, a timestamp without milliseconds) | the column stays NULL and the value is kept **unchanged** in `extra`; the document reads back identical | `diverted` counts per `collection.field` |
| two documents clash on a natural key (duplicate `trips.slug`, duplicate `users.qr_token`, two rows for one event + user) | both documents are kept; the later one's clashing key(s) move to `extra` | `demoted` counts per `collection.columns` |
| a document cannot be placed at all (orphan `event_secrets` whose event was deleted, `data` that is not an object) | not inserted; its original JSON and the reason go to `migration_rejects` | `rejected` count |

A summary per collection (`read / inserted / demoted / rejected / diverted`) is logged
(`[migrate] users: 120 read, 120 inserted; type anomalies {"users.streak":2}`) and stored in
`schema_migrations.details` for migration 002:

```sql
SELECT details->'totals' FROM schema_migrations WHERE version = '002';
SELECT collection, doc_id, error FROM migration_rejects ORDER BY id;
```

Every document that was inserted reads back **deep-equal** through the store (this is what
`test/migration.test.js` asserts for realistic and dirty samples of every collection).

## Deploying on Railway

1. **Back up first.** The migration is non-destructive (legacy tables are kept) but take a dump anyway:
   `pg_dump "$DATABASE_PUBLIC_URL" -Fc -f folk-before-typed.dump` (Railway: Postgres service -> Variables ->
   `DATABASE_PUBLIC_URL`; or use the service's Backups tab). Expect the database to be roughly 2x its size until
   the legacy tables are dropped by hand.
2. **Rehearse** (recommended): restore the dump into a scratch Postgres and run
   `DATABASE_URL=postgres://scratch npm run migrate`; read the summary and `migration_rejects`.
3. **Deploy** the new release. On boot the server migrates automatically (a few seconds for ~100k documents:
   ~4 s for 120k rows locally). Watch the deploy log for `[migrate] applied 001...`, `[migrate] legacy import: {...}`.
   *Rolling deploys:* until the old instance stops, it still queries the old table shapes and will return errors.
   For zero surprises either accept a short window, or stop the old service first, or set `DB_AUTO_MIGRATE=false`,
   stop the service, run `DATABASE_URL="$DATABASE_PUBLIC_URL" npm run migrate` from your machine, then deploy.
4. **Verify**: `SELECT version, applied_at FROM schema_migrations;`, `SELECT count(*) FROM migration_rejects;`,
   open the site, `POST /dbStatus` as admin (row counts per table), and the app's normal flows.
5. **Later** (after a week or two, once nothing needs the old copy): drop `legacy_*` and, if desired,
   `migration_rejects` yourself. Nothing does this automatically.

Environment: `PG_POOL_MAX` (default 10 connections), `DB_AUTO_MIGRATE` (default `true`); the existing `DATABASE_URL`.
The container image only needs `src/` (migrations are under `src/db/migrations`); `scripts/` is for use from a checkout.

## Rollback (reverse migration)

Writes made after the migration exist only in the typed tables, so simply renaming `legacy_*` back would lose
them. Use the rollback script instead (also `src/db/rollback.js`; tested by `test/rollback.test.js`):

```bash
# 1. stop the server, take a backup
# 2.
DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/rollback-typed.js --yes
# 3. deploy the previous release
```

In one transaction it (a) refreshes every `legacy_<name>` from the typed table (upserts all current documents,
removes rows deleted since, leaves documents that migration 002 had rejected), (b) renames the typed tables to
`typed_backup_<name>` and (c) renames `legacy_<name>` back to `<name>`, sets `docs_other` / `migration_rejects`
aside the same way and clears `schema_migrations`. Nothing is dropped. Deploying the typed release again later simply
migrates again from the restored generic tables (the test proves the documents are identical before and after a
rollback + re-migration). Documents are re-serialised from the typed rows, so keys, values and timestamps are the
same; `version` / `created_at` / `updated_at` are preserved.
