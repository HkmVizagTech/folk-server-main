-- 001: typed relational schema.
--
-- Replaces the generic (id, data jsonb, version, created_at, updated_at) table
-- per collection with real tables. Order of business:
--   1. every legacy generic table is RENAMED to legacy_<name> (kept for
--      rollback, never dropped; its indexes/constraints are renamed too so the
--      new tables can use the natural names),
--   2. the typed tables, indexes and FKs are created (generated from
--      src/db/schema by scripts/gen-schema-sql.js),
--   3. docs_other (generic fallback for collections outside the registry) and
--      migration_rejects (documents a data migration could not place).
-- Migration 002 copies the documents across.

DO $$
DECLARE
  r record;
  c record;
  legacy text;
BEGIN
  FOR r IN
    SELECT cl.relname
    FROM pg_class cl
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = current_schema()
      AND cl.relkind = 'r'
      AND cl.relname NOT LIKE 'legacy\_%'
      AND cl.relname NOT IN ('schema_migrations', 'migration_rejects', 'docs_other')
      AND (SELECT count(*) FROM pg_attribute a
           WHERE a.attrelid = cl.oid AND NOT a.attisdropped
             AND ((a.attname = 'id' AND a.atttypid = 'text'::regtype)
               OR (a.attname = 'data' AND a.atttypid = 'jsonb'::regtype)
               OR (a.attname = 'version' AND a.atttypid = 'bigint'::regtype)
               OR (a.attname = 'created_at' AND a.atttypid = 'timestamptz'::regtype)
               OR (a.attname = 'updated_at' AND a.atttypid = 'timestamptz'::regtype))) = 5
  LOOP
    legacy := 'legacy_' || r.relname;
    EXECUTE format('ALTER TABLE %I RENAME TO %I', r.relname, legacy);
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('%I', legacy)::regclass LOOP
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', legacy, c.conname, 'legacy_' || c.conname);
    END LOOP;
    FOR c IN SELECT indexname FROM pg_indexes
             WHERE schemaname = current_schema() AND tablename = legacy AND indexname NOT LIKE 'legacy\_%' LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I', c.indexname, 'legacy_' || c.indexname);
    END LOOP;
    RAISE NOTICE 'legacy table % kept as %', r.relname, legacy;
  END LOOP;
END $$;

-- users
CREATE TABLE "users" (
  "id" text PRIMARY KEY,
  "uid" text,
  "name" text,
  "full_name" text,
  "display_name" text,
  "email" text,
  "phone" text,
  "phone_normalized" text,
  "photo" text,
  "photo_url" text,
  "profile_image" text,
  "role" text,
  "qr_token" text,
  "username" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "gender" text,
  "dob" date,
  "occupation" text,
  "qualification" text,
  "city" text,
  "state" text,
  "country" text,
  "center" text,
  "address" text,
  "father_name" text,
  "father_phone" text,
  "spouse_id" text,
  "level" text,
  "stage" text,
  "guide_id" text,
  "guide_name" text,
  "guide_phone" text,
  "assigned_group" text,
  "next_follow_up_date" date,
  "last_follow_up_at" timestamptz,
  "last_follow_up_note" text,
  "streak" integer,
  "longest_streak" integer,
  "score" integer,
  "last_sadhana_date" date,
  "last_completed_sadhana_date" date,
  "sadhana_target" integer,
  "metadata" jsonb,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_role_chk" CHECK ("role" IN ('admin', 'folks_head', 'devotee', 'volunteer')),
  CONSTRAINT "users_stage_chk" CHECK ("stage" IN ('new', 'regular', 'practising', 'committed', 'resident')),
  CONSTRAINT "users_streak_chk" CHECK ("streak" >= 0),
  CONSTRAINT "users_longest_streak_chk" CHECK ("longest_streak" >= 0),
  CONSTRAINT "users_score_chk" CHECK ("score" >= 0),
  CONSTRAINT "users_sadhana_target_chk" CHECK ("sadhana_target" >= 0),
  CONSTRAINT "users_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "users_qr_token_key" UNIQUE ("qr_token")
);
CREATE INDEX "users_phone_normalized_idx" ON "users" ("phone_normalized");
CREATE INDEX "users_phone_idx" ON "users" ("phone");
CREATE INDEX "users_guide_id_idx" ON "users" ("guide_id");
CREATE INDEX "users_role_idx" ON "users" ("role");
CREATE INDEX "users_uid_idx" ON "users" ("uid");
COMMENT ON TABLE "users" IS 'users: id = Firebase Auth uid, or manual_<uuid> for staff-created profiles without a login';
COMMENT ON COLUMN "users"."uid" IS 'document field "uid"';
COMMENT ON COLUMN "users"."name" IS 'document field "name"';
COMMENT ON COLUMN "users"."full_name" IS 'document field "fullName"';
COMMENT ON COLUMN "users"."display_name" IS 'document field "displayName"';
COMMENT ON COLUMN "users"."email" IS 'document field "email"';
COMMENT ON COLUMN "users"."phone" IS 'document field "phone"';
COMMENT ON COLUMN "users"."phone_normalized" IS 'document field "phoneNormalized"';
COMMENT ON COLUMN "users"."photo" IS 'document field "photo"';
COMMENT ON COLUMN "users"."photo_url" IS 'document field "photoURL"';
COMMENT ON COLUMN "users"."profile_image" IS 'document field "profileImage"';
COMMENT ON COLUMN "users"."role" IS 'document field "role"';
COMMENT ON COLUMN "users"."qr_token" IS 'document field "qrToken"';
COMMENT ON COLUMN "users"."username" IS 'document field "username"';
COMMENT ON COLUMN "users"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "users"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "users"."gender" IS 'document field "gender"';
COMMENT ON COLUMN "users"."dob" IS 'document field "dob"';
COMMENT ON COLUMN "users"."occupation" IS 'document field "occupation"';
COMMENT ON COLUMN "users"."qualification" IS 'document field "qualification"';
COMMENT ON COLUMN "users"."city" IS 'document field "city"';
COMMENT ON COLUMN "users"."state" IS 'document field "state"';
COMMENT ON COLUMN "users"."country" IS 'document field "country"';
COMMENT ON COLUMN "users"."center" IS 'document field "center"';
COMMENT ON COLUMN "users"."address" IS 'document field "address"';
COMMENT ON COLUMN "users"."father_name" IS 'document field "fatherName"';
COMMENT ON COLUMN "users"."father_phone" IS 'document field "fatherPhone"';
COMMENT ON COLUMN "users"."spouse_id" IS 'document field "spouseId"';
COMMENT ON COLUMN "users"."level" IS 'document field "level"';
COMMENT ON COLUMN "users"."stage" IS 'document field "stage"';
COMMENT ON COLUMN "users"."guide_id" IS 'document field "guideId"';
COMMENT ON COLUMN "users"."guide_name" IS 'document field "guideName"';
COMMENT ON COLUMN "users"."guide_phone" IS 'document field "guidePhone"';
COMMENT ON COLUMN "users"."assigned_group" IS 'document field "assignedGroup"';
COMMENT ON COLUMN "users"."next_follow_up_date" IS 'document field "nextFollowUpDate"';
COMMENT ON COLUMN "users"."last_follow_up_at" IS 'document field "lastFollowUpAt"';
COMMENT ON COLUMN "users"."last_follow_up_note" IS 'document field "lastFollowUpNote"';
COMMENT ON COLUMN "users"."streak" IS 'document field "streak"';
COMMENT ON COLUMN "users"."longest_streak" IS 'document field "longestStreak"';
COMMENT ON COLUMN "users"."score" IS 'document field "score"';
COMMENT ON COLUMN "users"."last_sadhana_date" IS 'document field "lastSadhanaDate"';
COMMENT ON COLUMN "users"."last_completed_sadhana_date" IS 'document field "lastCompletedSadhanaDate"';
COMMENT ON COLUMN "users"."sadhana_target" IS 'document field "sadhanaTarget"';
COMMENT ON COLUMN "users"."metadata" IS 'document field "metadata"';
COMMENT ON COLUMN "users"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- events
CREATE TABLE "events" (
  "id" text PRIMARY KEY,
  "title" text,
  "category" text,
  "date_label" text,
  "date_iso" timestamptz,
  "time_label" text,
  "location" text,
  "description" text,
  "img" text,
  "audience" text,
  "owner_id" text,
  "owner_name" text,
  "group_id" text,
  "created_by" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "attending_count" integer,
  "declined_count" integer,
  "attendees" integer,
  "status" text,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "events_audience_chk" CHECK ("audience" IN ('all', 'mine', 'residents')),
  CONSTRAINT "events_attending_count_chk" CHECK ("attending_count" >= 0),
  CONSTRAINT "events_declined_count_chk" CHECK ("declined_count" >= 0),
  CONSTRAINT "events_attendees_chk" CHECK ("attendees" >= 0),
  CONSTRAINT "events_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "events_date_iso_idx" ON "events" ("date_iso");
CREATE INDEX "events_owner_id_idx" ON "events" ("owner_id");
CREATE INDEX "events_audience_idx" ON "events" ("audience");
COMMENT ON TABLE "events" IS 'events: id = 20-char auto id';
COMMENT ON COLUMN "events"."title" IS 'document field "title"';
COMMENT ON COLUMN "events"."category" IS 'document field "category"';
COMMENT ON COLUMN "events"."date_label" IS 'document field "date"';
COMMENT ON COLUMN "events"."date_iso" IS 'document field "dateISO"';
COMMENT ON COLUMN "events"."time_label" IS 'document field "time"';
COMMENT ON COLUMN "events"."location" IS 'document field "location"';
COMMENT ON COLUMN "events"."description" IS 'document field "description"';
COMMENT ON COLUMN "events"."img" IS 'document field "img"';
COMMENT ON COLUMN "events"."audience" IS 'document field "audience"';
COMMENT ON COLUMN "events"."owner_id" IS 'document field "ownerId"';
COMMENT ON COLUMN "events"."owner_name" IS 'document field "ownerName"';
COMMENT ON COLUMN "events"."group_id" IS 'document field "groupId"';
COMMENT ON COLUMN "events"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "events"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "events"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "events"."attending_count" IS 'document field "attendingCount"';
COMMENT ON COLUMN "events"."declined_count" IS 'document field "declinedCount"';
COMMENT ON COLUMN "events"."attendees" IS 'document field "attendees"';
COMMENT ON COLUMN "events"."status" IS 'document field "status"';
COMMENT ON COLUMN "events"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- event_secrets
CREATE TABLE "event_secrets" (
  "id" text PRIMARY KEY,
  "attendance_token" text,
  "doc_created_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "event_secrets_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
COMMENT ON TABLE "event_secrets" IS 'event_secrets: id = the event id';
COMMENT ON COLUMN "event_secrets"."attendance_token" IS 'document field "attendanceToken"';
COMMENT ON COLUMN "event_secrets"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "event_secrets"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';
ALTER TABLE "event_secrets" ADD CONSTRAINT "event_secrets_id_fkey" FOREIGN KEY ("id") REFERENCES events (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- registrations
CREATE TABLE "registrations" (
  "id" text PRIMARY KEY,
  "event_id" text,
  "event_title" text,
  "user_id" text,
  "user_name" text,
  "token" text,
  "status" text,
  "doc_updated_at" timestamptz,
  "doc_created_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "registrations_status_chk" CHECK ("status" IN ('Attending', 'Not Attending', 'Cancelled')),
  CONSTRAINT "registrations_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "registrations_event_id_user_id_key" UNIQUE ("event_id", "user_id")
);
CREATE INDEX "registrations_user_id_idx" ON "registrations" ("user_id");
CREATE INDEX "registrations_token_partial_idx" ON "registrations" ("token") WHERE token IS NOT NULL;
COMMENT ON TABLE "registrations" IS 'registrations: id = <eventId>_<userId>';
COMMENT ON COLUMN "registrations"."event_id" IS 'document field "eventId"';
COMMENT ON COLUMN "registrations"."event_title" IS 'document field "eventTitle"';
COMMENT ON COLUMN "registrations"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "registrations"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "registrations"."token" IS 'document field "token"';
COMMENT ON COLUMN "registrations"."status" IS 'document field "status"';
COMMENT ON COLUMN "registrations"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "registrations"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "registrations"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- attendance
CREATE TABLE "attendance" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "uid" text,
  "name" text,
  "event_id" text,
  "session" text,
  "status" text,
  "method" text,
  "marked_by" text,
  "marked_by_name" text,
  "time_label" text,
  "doc_created_at" timestamptz,
  "recorded_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "attendance_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "attendance_event_id_user_id_key" UNIQUE ("event_id", "user_id")
);
CREATE INDEX "attendance_user_id_idx" ON "attendance" ("user_id");
CREATE INDEX "attendance_doc_created_at_desc_idx" ON "attendance" ("doc_created_at" DESC);
COMMENT ON TABLE "attendance" IS 'attendance: id = <eventId>_<userId>';
COMMENT ON COLUMN "attendance"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "attendance"."uid" IS 'document field "uid"';
COMMENT ON COLUMN "attendance"."name" IS 'document field "name"';
COMMENT ON COLUMN "attendance"."event_id" IS 'document field "eventId"';
COMMENT ON COLUMN "attendance"."session" IS 'document field "session"';
COMMENT ON COLUMN "attendance"."status" IS 'document field "status"';
COMMENT ON COLUMN "attendance"."method" IS 'document field "method"';
COMMENT ON COLUMN "attendance"."marked_by" IS 'document field "markedBy"';
COMMENT ON COLUMN "attendance"."marked_by_name" IS 'document field "markedByName"';
COMMENT ON COLUMN "attendance"."time_label" IS 'document field "time"';
COMMENT ON COLUMN "attendance"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "attendance"."recorded_at" IS 'document field "timestamp"';
COMMENT ON COLUMN "attendance"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- prasadam_logs
CREATE TABLE "prasadam_logs" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "name" text,
  "event_id" text,
  "event_title" text,
  "received" boolean,
  "recorded_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "prasadam_logs_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "prasadam_logs_event_id_user_id_key" UNIQUE ("event_id", "user_id")
);
CREATE INDEX "prasadam_logs_user_id_idx" ON "prasadam_logs" ("user_id");
CREATE INDEX "prasadam_logs_recorded_at_desc_idx" ON "prasadam_logs" ("recorded_at" DESC);
COMMENT ON TABLE "prasadam_logs" IS 'prasadam_logs: id = <eventId>_<userId>';
COMMENT ON COLUMN "prasadam_logs"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "prasadam_logs"."name" IS 'document field "name"';
COMMENT ON COLUMN "prasadam_logs"."event_id" IS 'document field "eventId"';
COMMENT ON COLUMN "prasadam_logs"."event_title" IS 'document field "eventTitle"';
COMMENT ON COLUMN "prasadam_logs"."received" IS 'document field "received"';
COMMENT ON COLUMN "prasadam_logs"."recorded_at" IS 'document field "timestamp"';
COMMENT ON COLUMN "prasadam_logs"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- sadhana_logs
CREATE TABLE "sadhana_logs" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "log_date" date,
  "user_name" text,
  "target" integer,
  "rounds_completed" integer,
  "progress_percentage" integer,
  "streak" integer,
  "score" integer,
  "status" text,
  "completed" boolean,
  "bonus_claimed" jsonb,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sadhana_logs_target_chk" CHECK ("target" >= 0),
  CONSTRAINT "sadhana_logs_rounds_completed_chk" CHECK ("rounds_completed" >= 0),
  CONSTRAINT "sadhana_logs_progress_percentage_chk" CHECK ("progress_percentage" >= 0 AND "progress_percentage" <= 100),
  CONSTRAINT "sadhana_logs_streak_chk" CHECK ("streak" >= 0),
  CONSTRAINT "sadhana_logs_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "sadhana_logs_user_id_log_date_key" UNIQUE ("user_id", "log_date")
);
CREATE INDEX "sadhana_logs_user_id_log_date_desc_idx" ON "sadhana_logs" ("user_id", "log_date" DESC);
COMMENT ON TABLE "sadhana_logs" IS 'sadhana_logs: id = <uid>_<YYYY-MM-DD> (IST date)';
COMMENT ON COLUMN "sadhana_logs"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "sadhana_logs"."log_date" IS 'document field "date"';
COMMENT ON COLUMN "sadhana_logs"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "sadhana_logs"."target" IS 'document field "target"';
COMMENT ON COLUMN "sadhana_logs"."rounds_completed" IS 'document field "roundsCompleted"';
COMMENT ON COLUMN "sadhana_logs"."progress_percentage" IS 'document field "progressPercentage"';
COMMENT ON COLUMN "sadhana_logs"."streak" IS 'document field "streak"';
COMMENT ON COLUMN "sadhana_logs"."score" IS 'document field "score"';
COMMENT ON COLUMN "sadhana_logs"."status" IS 'document field "status"';
COMMENT ON COLUMN "sadhana_logs"."completed" IS 'document field "completed"';
COMMENT ON COLUMN "sadhana_logs"."bonus_claimed" IS 'document field "bonusClaimed"';
COMMENT ON COLUMN "sadhana_logs"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "sadhana_logs"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "sadhana_logs"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- sevas
CREATE TABLE "sevas" (
  "id" text PRIMARY KEY,
  "title" text,
  "description" text,
  "seva_type" text,
  "seva_date" date,
  "time_label" text,
  "location" text,
  "max_volunteers" integer,
  "is_recurring" boolean,
  "count_registered" integer,
  "created_by" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sevas_max_volunteers_chk" CHECK ("max_volunteers" >= 0),
  CONSTRAINT "sevas_count_registered_chk" CHECK ("count_registered" >= 0),
  CONSTRAINT "sevas_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "sevas_seva_date_idx" ON "sevas" ("seva_date");
COMMENT ON TABLE "sevas" IS 'sevas: id = 20-char auto id';
COMMENT ON COLUMN "sevas"."title" IS 'document field "title"';
COMMENT ON COLUMN "sevas"."description" IS 'document field "description"';
COMMENT ON COLUMN "sevas"."seva_type" IS 'document field "sevaType"';
COMMENT ON COLUMN "sevas"."seva_date" IS 'document field "date"';
COMMENT ON COLUMN "sevas"."time_label" IS 'document field "time"';
COMMENT ON COLUMN "sevas"."location" IS 'document field "location"';
COMMENT ON COLUMN "sevas"."max_volunteers" IS 'document field "maxVolunteers"';
COMMENT ON COLUMN "sevas"."is_recurring" IS 'document field "isRecurring"';
COMMENT ON COLUMN "sevas"."count_registered" IS 'document field "countRegistered"';
COMMENT ON COLUMN "sevas"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "sevas"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "sevas"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "sevas"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- seva_registrations
CREATE TABLE "seva_registrations" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "seva_id" text,
  "seva_title" text,
  "user_name" text,
  "user_phone" text,
  "status" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "seva_registrations_status_chk" CHECK ("status" IN ('registered', 'cancelled', 'completed')),
  CONSTRAINT "seva_registrations_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "seva_registrations_user_id_seva_id_key" UNIQUE ("user_id", "seva_id")
);
CREATE INDEX "seva_registrations_seva_id_idx" ON "seva_registrations" ("seva_id");
COMMENT ON TABLE "seva_registrations" IS 'seva_registrations: id = <userId>_<sevaId>';
COMMENT ON COLUMN "seva_registrations"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "seva_registrations"."seva_id" IS 'document field "sevaId"';
COMMENT ON COLUMN "seva_registrations"."seva_title" IS 'document field "sevaTitle"';
COMMENT ON COLUMN "seva_registrations"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "seva_registrations"."user_phone" IS 'document field "userPhone"';
COMMENT ON COLUMN "seva_registrations"."status" IS 'document field "status"';
COMMENT ON COLUMN "seva_registrations"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "seva_registrations"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "seva_registrations"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- trips
CREATE TABLE "trips" (
  "id" text PRIMARY KEY,
  "slug" text,
  "title" text,
  "subtitle" text,
  "location" text,
  "description" text,
  "cover_image" text,
  "gallery" text[],
  "start_date" date,
  "end_date" date,
  "duration_label" text,
  "price" numeric(12,2),
  "original_price" numeric(12,2),
  "advance_amount" numeric(12,2),
  "capacity" integer,
  "eligibility" text,
  "status" text,
  "registration_open" boolean,
  "online_payment_enabled" boolean,
  "cash_payment_enabled" boolean,
  "highlights" text[],
  "inclusions" text[],
  "exclusions" text[],
  "itinerary" jsonb,
  "locations" jsonb,
  "meeting_point" text,
  "contact_phone" text,
  "created_by" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trips_price_chk" CHECK ("price" >= 0),
  CONSTRAINT "trips_original_price_chk" CHECK ("original_price" >= 0),
  CONSTRAINT "trips_advance_amount_chk" CHECK ("advance_amount" >= 0),
  CONSTRAINT "trips_capacity_chk" CHECK ("capacity" >= 0),
  CONSTRAINT "trips_status_chk" CHECK ("status" IN ('draft', 'upcoming', 'ongoing', 'completed', 'cancelled')),
  CONSTRAINT "trips_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "trips_slug_key" UNIQUE ("slug")
);
CREATE INDEX "trips_start_date_idx" ON "trips" ("start_date");
COMMENT ON TABLE "trips" IS 'trips: id = 20-char auto id';
COMMENT ON COLUMN "trips"."slug" IS 'document field "slug"';
COMMENT ON COLUMN "trips"."title" IS 'document field "title"';
COMMENT ON COLUMN "trips"."subtitle" IS 'document field "subtitle"';
COMMENT ON COLUMN "trips"."location" IS 'document field "location"';
COMMENT ON COLUMN "trips"."description" IS 'document field "description"';
COMMENT ON COLUMN "trips"."cover_image" IS 'document field "coverImage"';
COMMENT ON COLUMN "trips"."gallery" IS 'document field "gallery"';
COMMENT ON COLUMN "trips"."start_date" IS 'document field "startDate"';
COMMENT ON COLUMN "trips"."end_date" IS 'document field "endDate"';
COMMENT ON COLUMN "trips"."duration_label" IS 'document field "durationLabel"';
COMMENT ON COLUMN "trips"."price" IS 'document field "price"';
COMMENT ON COLUMN "trips"."original_price" IS 'document field "originalPrice"';
COMMENT ON COLUMN "trips"."advance_amount" IS 'document field "advanceAmount"';
COMMENT ON COLUMN "trips"."capacity" IS 'document field "capacity"';
COMMENT ON COLUMN "trips"."eligibility" IS 'document field "eligibility"';
COMMENT ON COLUMN "trips"."status" IS 'document field "status"';
COMMENT ON COLUMN "trips"."registration_open" IS 'document field "registrationOpen"';
COMMENT ON COLUMN "trips"."online_payment_enabled" IS 'document field "onlinePaymentEnabled"';
COMMENT ON COLUMN "trips"."cash_payment_enabled" IS 'document field "cashPaymentEnabled"';
COMMENT ON COLUMN "trips"."highlights" IS 'document field "highlights"';
COMMENT ON COLUMN "trips"."inclusions" IS 'document field "inclusions"';
COMMENT ON COLUMN "trips"."exclusions" IS 'document field "exclusions"';
COMMENT ON COLUMN "trips"."itinerary" IS 'document field "itinerary"';
COMMENT ON COLUMN "trips"."locations" IS 'document field "locations"';
COMMENT ON COLUMN "trips"."meeting_point" IS 'document field "meetingPoint"';
COMMENT ON COLUMN "trips"."contact_phone" IS 'document field "contactPhone"';
COMMENT ON COLUMN "trips"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "trips"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "trips"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "trips"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- trip_registrations
CREATE TABLE "trip_registrations" (
  "id" text PRIMARY KEY,
  "trip_id" text,
  "trip_slug" text,
  "trip_title" text,
  "user_id" text,
  "user_name" text,
  "user_phone" text,
  "user_email" text,
  "seats" integer,
  "amount_due" numeric(12,2),
  "payment_mode" text,
  "payment_order_id" text,
  "status" text,
  "confirmed_by" text,
  "staff_notes" text,
  "cash_collected" boolean,
  "cash_amount" numeric(12,2),
  "cash_collected_at" timestamptz,
  "cash_collected_by" text,
  "travellers" jsonb,
  "emergency_contact" text,
  "pickup" text,
  "traveller_notes" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trip_registrations_seats_chk" CHECK ("seats" >= 1 AND "seats" <= 20),
  CONSTRAINT "trip_registrations_amount_due_chk" CHECK ("amount_due" >= 0),
  CONSTRAINT "trip_registrations_payment_mode_chk" CHECK ("payment_mode" IN ('online', 'cash')),
  CONSTRAINT "trip_registrations_status_chk" CHECK ("status" IN ('pending', 'confirmed', 'waitlisted', 'cancelled')),
  CONSTRAINT "trip_registrations_cash_amount_chk" CHECK ("cash_amount" >= 0),
  CONSTRAINT "trip_registrations_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "trip_registrations_user_id_idx" ON "trip_registrations" ("user_id");
CREATE INDEX "trip_registrations_trip_id_status_idx" ON "trip_registrations" ("trip_id", "status");
CREATE INDEX "trip_registrations_payment_order_id_partial_idx" ON "trip_registrations" ("payment_order_id") WHERE payment_order_id IS NOT NULL;
COMMENT ON TABLE "trip_registrations" IS 'trip_registrations: id = 20-char auto id';
COMMENT ON COLUMN "trip_registrations"."trip_id" IS 'document field "tripId"';
COMMENT ON COLUMN "trip_registrations"."trip_slug" IS 'document field "tripSlug"';
COMMENT ON COLUMN "trip_registrations"."trip_title" IS 'document field "tripTitle"';
COMMENT ON COLUMN "trip_registrations"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "trip_registrations"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "trip_registrations"."user_phone" IS 'document field "userPhone"';
COMMENT ON COLUMN "trip_registrations"."user_email" IS 'document field "userEmail"';
COMMENT ON COLUMN "trip_registrations"."seats" IS 'document field "seats"';
COMMENT ON COLUMN "trip_registrations"."amount_due" IS 'document field "amountDue"';
COMMENT ON COLUMN "trip_registrations"."payment_mode" IS 'document field "paymentMode"';
COMMENT ON COLUMN "trip_registrations"."payment_order_id" IS 'document field "paymentOrderId"';
COMMENT ON COLUMN "trip_registrations"."status" IS 'document field "status"';
COMMENT ON COLUMN "trip_registrations"."confirmed_by" IS 'document field "confirmedBy"';
COMMENT ON COLUMN "trip_registrations"."staff_notes" IS 'document field "staffNotes"';
COMMENT ON COLUMN "trip_registrations"."cash_collected" IS 'document field "cashCollected"';
COMMENT ON COLUMN "trip_registrations"."cash_amount" IS 'document field "cashAmount"';
COMMENT ON COLUMN "trip_registrations"."cash_collected_at" IS 'document field "cashCollectedAt"';
COMMENT ON COLUMN "trip_registrations"."cash_collected_by" IS 'document field "cashCollectedBy"';
COMMENT ON COLUMN "trip_registrations"."travellers" IS 'document field "travellers"';
COMMENT ON COLUMN "trip_registrations"."emergency_contact" IS 'document field "emergencyContact"';
COMMENT ON COLUMN "trip_registrations"."pickup" IS 'document field "pickup"';
COMMENT ON COLUMN "trip_registrations"."traveller_notes" IS 'document field "travellerNotes"';
COMMENT ON COLUMN "trip_registrations"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "trip_registrations"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "trip_registrations"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- payments
CREATE TABLE "payments" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "amount" numeric(12,2),
  "amount_paise" bigint,
  "currency" text,
  "purpose" text,
  "trip_id" text,
  "trip_registration_id" text,
  "event_id" text,
  "status" text,
  "verified" boolean,
  "payment_id" text,
  "method" text,
  "verified_by" text,
  "captured_at" timestamptz,
  "failed_at" timestamptz,
  "failure_reason" text,
  "last_failed_attempt" jsonb,
  "paid_amount_paise" bigint,
  "paid_currency" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payments_amount_chk" CHECK ("amount" >= 0),
  CONSTRAINT "payments_amount_paise_chk" CHECK ("amount_paise" >= 0),
  CONSTRAINT "payments_purpose_chk" CHECK ("purpose" IN ('trip', 'donation')),
  CONSTRAINT "payments_status_chk" CHECK ("status" IN ('pending', 'completed', 'failed', 'amount_mismatch')),
  CONSTRAINT "payments_paid_amount_paise_chk" CHECK ("paid_amount_paise" >= 0),
  CONSTRAINT "payments_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "payments_user_id_idx" ON "payments" ("user_id");
CREATE INDEX "payments_trip_registration_id_partial_idx" ON "payments" ("trip_registration_id") WHERE trip_registration_id IS NOT NULL;
CREATE INDEX "payments_status_idx" ON "payments" ("status");
COMMENT ON TABLE "payments" IS 'payments: id = Razorpay order id (order_XXXX)';
COMMENT ON COLUMN "payments"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "payments"."amount" IS 'document field "amount"';
COMMENT ON COLUMN "payments"."amount_paise" IS 'document field "amountPaise"';
COMMENT ON COLUMN "payments"."currency" IS 'document field "currency"';
COMMENT ON COLUMN "payments"."purpose" IS 'document field "purpose"';
COMMENT ON COLUMN "payments"."trip_id" IS 'document field "tripId"';
COMMENT ON COLUMN "payments"."trip_registration_id" IS 'document field "tripRegistrationId"';
COMMENT ON COLUMN "payments"."event_id" IS 'document field "eventId"';
COMMENT ON COLUMN "payments"."status" IS 'document field "status"';
COMMENT ON COLUMN "payments"."verified" IS 'document field "verified"';
COMMENT ON COLUMN "payments"."payment_id" IS 'document field "paymentId"';
COMMENT ON COLUMN "payments"."method" IS 'document field "method"';
COMMENT ON COLUMN "payments"."verified_by" IS 'document field "verifiedBy"';
COMMENT ON COLUMN "payments"."captured_at" IS 'document field "capturedAt"';
COMMENT ON COLUMN "payments"."failed_at" IS 'document field "failedAt"';
COMMENT ON COLUMN "payments"."failure_reason" IS 'document field "failureReason"';
COMMENT ON COLUMN "payments"."last_failed_attempt" IS 'document field "lastFailedAttempt"';
COMMENT ON COLUMN "payments"."paid_amount_paise" IS 'document field "paidAmountPaise"';
COMMENT ON COLUMN "payments"."paid_currency" IS 'document field "paidCurrency"';
COMMENT ON COLUMN "payments"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "payments"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "payments"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- accommodation_requests
CREATE TABLE "accommodation_requests" (
  "id" text PRIMARY KEY,
  "type" text,
  "guest_count" integer,
  "arrival_date" date,
  "departure_date" date,
  "requirements" text,
  "user_id" text,
  "user_name" text,
  "status" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "accommodation_requests_guest_count_chk" CHECK ("guest_count" >= 1),
  CONSTRAINT "accommodation_requests_status_chk" CHECK ("status" IN ('pending', 'recommended', 'approved', 'rejected')),
  CONSTRAINT "accommodation_requests_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "accommodation_requests_user_id_doc_created_at_desc_idx" ON "accommodation_requests" ("user_id", "doc_created_at" DESC);
CREATE INDEX "accommodation_requests_doc_created_at_desc_idx" ON "accommodation_requests" ("doc_created_at" DESC);
CREATE INDEX "accommodation_requests_status_idx" ON "accommodation_requests" ("status");
CREATE INDEX "accommodation_requests_user_id_status_idx" ON "accommodation_requests" ("user_id", "status");
COMMENT ON TABLE "accommodation_requests" IS 'accommodation_requests: id = 20-char auto id';
COMMENT ON COLUMN "accommodation_requests"."type" IS 'document field "type"';
COMMENT ON COLUMN "accommodation_requests"."guest_count" IS 'document field "guestCount"';
COMMENT ON COLUMN "accommodation_requests"."arrival_date" IS 'document field "arrivalDate"';
COMMENT ON COLUMN "accommodation_requests"."departure_date" IS 'document field "departureDate"';
COMMENT ON COLUMN "accommodation_requests"."requirements" IS 'document field "requirements"';
COMMENT ON COLUMN "accommodation_requests"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "accommodation_requests"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "accommodation_requests"."status" IS 'document field "status"';
COMMENT ON COLUMN "accommodation_requests"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "accommodation_requests"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "accommodation_requests"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- hostel_listings
CREATE TABLE "hostel_listings" (
  "id" text PRIMARY KEY,
  "name" text,
  "description" text,
  "capacity" integer,
  "amenities" text[],
  "img" text,
  "active" boolean,
  "created_by" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hostel_listings_capacity_chk" CHECK ("capacity" >= 0),
  CONSTRAINT "hostel_listings_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
COMMENT ON TABLE "hostel_listings" IS 'hostel_listings: id = 20-char auto id';
COMMENT ON COLUMN "hostel_listings"."name" IS 'document field "name"';
COMMENT ON COLUMN "hostel_listings"."description" IS 'document field "description"';
COMMENT ON COLUMN "hostel_listings"."capacity" IS 'document field "capacity"';
COMMENT ON COLUMN "hostel_listings"."amenities" IS 'document field "amenities"';
COMMENT ON COLUMN "hostel_listings"."img" IS 'document field "img"';
COMMENT ON COLUMN "hostel_listings"."active" IS 'document field "active"';
COMMENT ON COLUMN "hostel_listings"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "hostel_listings"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "hostel_listings"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "hostel_listings"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- hostel_bookings
CREATE TABLE "hostel_bookings" (
  "id" text PRIMARY KEY,
  "listing_id" text,
  "listing_name" text,
  "user_id" text,
  "user_name" text,
  "check_in" date,
  "check_out" date,
  "guest_count" integer,
  "notes" text,
  "status" text,
  "staff_notes" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "hostel_bookings_guest_count_chk" CHECK ("guest_count" >= 1),
  CONSTRAINT "hostel_bookings_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT "hostel_bookings_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "hostel_bookings_user_id_doc_created_at_desc_idx" ON "hostel_bookings" ("user_id", "doc_created_at" DESC);
CREATE INDEX "hostel_bookings_doc_created_at_desc_idx" ON "hostel_bookings" ("doc_created_at" DESC);
CREATE INDEX "hostel_bookings_listing_id_idx" ON "hostel_bookings" ("listing_id");
CREATE INDEX "hostel_bookings_status_idx" ON "hostel_bookings" ("status");
COMMENT ON TABLE "hostel_bookings" IS 'hostel_bookings: id = 20-char auto id';
COMMENT ON COLUMN "hostel_bookings"."listing_id" IS 'document field "listingId"';
COMMENT ON COLUMN "hostel_bookings"."listing_name" IS 'document field "listingName"';
COMMENT ON COLUMN "hostel_bookings"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "hostel_bookings"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "hostel_bookings"."check_in" IS 'document field "checkIn"';
COMMENT ON COLUMN "hostel_bookings"."check_out" IS 'document field "checkOut"';
COMMENT ON COLUMN "hostel_bookings"."guest_count" IS 'document field "guestCount"';
COMMENT ON COLUMN "hostel_bookings"."notes" IS 'document field "notes"';
COMMENT ON COLUMN "hostel_bookings"."status" IS 'document field "status"';
COMMENT ON COLUMN "hostel_bookings"."staff_notes" IS 'document field "staffNotes"';
COMMENT ON COLUMN "hostel_bookings"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "hostel_bookings"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "hostel_bookings"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- courses
CREATE TABLE "courses" (
  "id" text PRIMARY KEY,
  "title" text,
  "description" text,
  "sessions" integer,
  "schedule" text,
  "active" boolean,
  "created_by" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "courses_sessions_chk" CHECK ("sessions" >= 0 AND "sessions" <= 1000),
  CONSTRAINT "courses_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
COMMENT ON TABLE "courses" IS 'courses: id = 20-char auto id';
COMMENT ON COLUMN "courses"."title" IS 'document field "title"';
COMMENT ON COLUMN "courses"."description" IS 'document field "description"';
COMMENT ON COLUMN "courses"."sessions" IS 'document field "sessions"';
COMMENT ON COLUMN "courses"."schedule" IS 'document field "schedule"';
COMMENT ON COLUMN "courses"."active" IS 'document field "active"';
COMMENT ON COLUMN "courses"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "courses"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "courses"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "courses"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- enrollments
CREATE TABLE "enrollments" (
  "id" text PRIMARY KEY,
  "course_id" text,
  "course_title" text,
  "user_id" text,
  "user_name" text,
  "user_phone" text,
  "status" text,
  "sessions_attended" integer,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrollments_status_chk" CHECK ("status" IN ('enrolled', 'completed')),
  CONSTRAINT "enrollments_sessions_attended_chk" CHECK ("sessions_attended" >= 0),
  CONSTRAINT "enrollments_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object'),
  CONSTRAINT "enrollments_course_id_user_id_key" UNIQUE ("course_id", "user_id")
);
CREATE INDEX "enrollments_user_id_idx" ON "enrollments" ("user_id");
COMMENT ON TABLE "enrollments" IS 'enrollments: id = <courseId>_<userId>';
COMMENT ON COLUMN "enrollments"."course_id" IS 'document field "courseId"';
COMMENT ON COLUMN "enrollments"."course_title" IS 'document field "courseTitle"';
COMMENT ON COLUMN "enrollments"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "enrollments"."user_name" IS 'document field "userName"';
COMMENT ON COLUMN "enrollments"."user_phone" IS 'document field "userPhone"';
COMMENT ON COLUMN "enrollments"."status" IS 'document field "status"';
COMMENT ON COLUMN "enrollments"."sessions_attended" IS 'document field "sessionsAttended"';
COMMENT ON COLUMN "enrollments"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "enrollments"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "enrollments"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- followups
CREATE TABLE "followups" (
  "id" text PRIMARY KEY,
  "member_id" text,
  "member_name" text,
  "guide_id" text,
  "guide_name" text,
  "channel" text,
  "note" text,
  "next_date" date,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "followups_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "followups_member_id_idx" ON "followups" ("member_id");
CREATE INDEX "followups_guide_id_idx" ON "followups" ("guide_id");
CREATE INDEX "followups_doc_created_at_idx" ON "followups" ("doc_created_at");
COMMENT ON TABLE "followups" IS 'followups: id = 20-char auto id';
COMMENT ON COLUMN "followups"."member_id" IS 'document field "memberId"';
COMMENT ON COLUMN "followups"."member_name" IS 'document field "memberName"';
COMMENT ON COLUMN "followups"."guide_id" IS 'document field "guideId"';
COMMENT ON COLUMN "followups"."guide_name" IS 'document field "guideName"';
COMMENT ON COLUMN "followups"."channel" IS 'document field "channel"';
COMMENT ON COLUMN "followups"."note" IS 'document field "note"';
COMMENT ON COLUMN "followups"."next_date" IS 'document field "nextDate"';
COMMENT ON COLUMN "followups"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "followups"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "followups"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- notifications
CREATE TABLE "notifications" (
  "id" text PRIMARY KEY,
  "type" text,
  "title" text,
  "message" text,
  "link" text,
  "doc_created_at" timestamptz,
  "created_by" text,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notifications_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "notifications_doc_created_at_desc_idx" ON "notifications" ("doc_created_at" DESC);
COMMENT ON TABLE "notifications" IS 'notifications: id = 20-char auto id';
COMMENT ON COLUMN "notifications"."type" IS 'document field "type"';
COMMENT ON COLUMN "notifications"."title" IS 'document field "title"';
COMMENT ON COLUMN "notifications"."message" IS 'document field "message"';
COMMENT ON COLUMN "notifications"."link" IS 'document field "link"';
COMMENT ON COLUMN "notifications"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "notifications"."created_by" IS 'document field "createdBy"';
COMMENT ON COLUMN "notifications"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- contact_messages
CREATE TABLE "contact_messages" (
  "id" text PRIMARY KEY,
  "user_id" text,
  "name" text,
  "phone" text,
  "email" text,
  "topic" text,
  "message" text,
  "status" text,
  "doc_created_at" timestamptz,
  "doc_updated_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "contact_messages_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "contact_messages_doc_created_at_idx" ON "contact_messages" ("doc_created_at");
COMMENT ON TABLE "contact_messages" IS 'contact_messages: id = 20-char auto id';
COMMENT ON COLUMN "contact_messages"."user_id" IS 'document field "userId"';
COMMENT ON COLUMN "contact_messages"."name" IS 'document field "name"';
COMMENT ON COLUMN "contact_messages"."phone" IS 'document field "phone"';
COMMENT ON COLUMN "contact_messages"."email" IS 'document field "email"';
COMMENT ON COLUMN "contact_messages"."topic" IS 'document field "topic"';
COMMENT ON COLUMN "contact_messages"."message" IS 'document field "message"';
COMMENT ON COLUMN "contact_messages"."status" IS 'document field "status"';
COMMENT ON COLUMN "contact_messages"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "contact_messages"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "contact_messages"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- broadcasts
CREATE TABLE "broadcasts" (
  "id" text PRIMARY KEY,
  "by_uid" text,
  "by_name" text,
  "audience" jsonb,
  "template_id" text,
  "params" text[],
  "total" integer,
  "sent" integer,
  "failed" integer,
  "doc_created_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "broadcasts_total_chk" CHECK ("total" >= 0),
  CONSTRAINT "broadcasts_sent_chk" CHECK ("sent" >= 0),
  CONSTRAINT "broadcasts_failed_chk" CHECK ("failed" >= 0),
  CONSTRAINT "broadcasts_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "broadcasts_doc_created_at_idx" ON "broadcasts" ("doc_created_at");
COMMENT ON TABLE "broadcasts" IS 'broadcasts: id = 20-char auto id';
COMMENT ON COLUMN "broadcasts"."by_uid" IS 'document field "byUid"';
COMMENT ON COLUMN "broadcasts"."by_name" IS 'document field "byName"';
COMMENT ON COLUMN "broadcasts"."audience" IS 'document field "audience"';
COMMENT ON COLUMN "broadcasts"."template_id" IS 'document field "templateId"';
COMMENT ON COLUMN "broadcasts"."params" IS 'document field "params"';
COMMENT ON COLUMN "broadcasts"."total" IS 'document field "total"';
COMMENT ON COLUMN "broadcasts"."sent" IS 'document field "sent"';
COMMENT ON COLUMN "broadcasts"."failed" IS 'document field "failed"';
COMMENT ON COLUMN "broadcasts"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "broadcasts"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- otp_codes
CREATE TABLE "otp_codes" (
  "id" text PRIMARY KEY,
  "code_hash" text,
  "code" text,
  "phone" text,
  "doc_created_at" timestamptz,
  "expires_at" timestamptz,
  "attempts" integer,
  "sends" jsonb,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "otp_codes_attempts_chk" CHECK ("attempts" >= 0),
  CONSTRAINT "otp_codes_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE INDEX "otp_codes_expires_at_partial_idx" ON "otp_codes" ("expires_at") WHERE expires_at IS NOT NULL;
COMMENT ON TABLE "otp_codes" IS 'otp_codes: id = normalised phone, 91XXXXXXXXXX';
COMMENT ON COLUMN "otp_codes"."code_hash" IS 'document field "codeHash"';
COMMENT ON COLUMN "otp_codes"."code" IS 'document field "code"';
COMMENT ON COLUMN "otp_codes"."phone" IS 'document field "phone"';
COMMENT ON COLUMN "otp_codes"."doc_created_at" IS 'document field "createdAt"';
COMMENT ON COLUMN "otp_codes"."expires_at" IS 'document field "expiresAt"';
COMMENT ON COLUMN "otp_codes"."attempts" IS 'document field "attempts"';
COMMENT ON COLUMN "otp_codes"."sends" IS 'document field "sends"';
COMMENT ON COLUMN "otp_codes"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- system
CREATE TABLE "system" (
  "id" text PRIMARY KEY,
  "source" text,
  "project_id" text,
  "counts" jsonb,
  "firestore_locked" boolean,
  "duration_ms" bigint,
  "completed_at" timestamptz,
  "done" text[],
  "doc_updated_at" timestamptz,
  "doc_version" integer,
  "scanned" integer,
  "updated" integer,
  "built_at" timestamptz,
  "extra" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "system_extra_object_chk" CHECK (jsonb_typeof("extra") = 'object')
);
COMMENT ON TABLE "system" IS 'system: id = migration | seeds | phoneIndex';
COMMENT ON COLUMN "system"."source" IS 'document field "source"';
COMMENT ON COLUMN "system"."project_id" IS 'document field "projectId"';
COMMENT ON COLUMN "system"."counts" IS 'document field "counts"';
COMMENT ON COLUMN "system"."firestore_locked" IS 'document field "firestoreLocked"';
COMMENT ON COLUMN "system"."duration_ms" IS 'document field "durationMs"';
COMMENT ON COLUMN "system"."completed_at" IS 'document field "completedAt"';
COMMENT ON COLUMN "system"."done" IS 'document field "done"';
COMMENT ON COLUMN "system"."doc_updated_at" IS 'document field "updatedAt"';
COMMENT ON COLUMN "system"."doc_version" IS 'document field "version"';
COMMENT ON COLUMN "system"."scanned" IS 'document field "scanned"';
COMMENT ON COLUMN "system"."updated" IS 'document field "updated"';
COMMENT ON COLUMN "system"."built_at" IS 'document field "builtAt"';
COMMENT ON COLUMN "system"."extra" IS 'Document keys that have no column, plus explicit nulls and values that do not fit their column type; merged back into the document on read.';

-- Generic fallback: ONLY for collections that are not in the registry. The
-- whole document lives in `data`; policies still deny these to browsers.
CREATE TABLE docs_other (
  path text PRIMARY KEY,
  collection text NOT NULL,
  doc_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_other_data_object_chk CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT docs_other_path_chk CHECK (path = collection || '/' || doc_id)
);
CREATE INDEX docs_other_collection_idx ON docs_other (collection, doc_id);
CREATE INDEX docs_other_data_gin ON docs_other USING gin (data jsonb_path_ops);

-- Documents a data migration (or the Firestore copy) could not place, with the
-- original JSON and the reason. Review and re-insert by hand if needed.
CREATE TABLE migration_rejects (
  id bigserial PRIMARY KEY,
  migration text,
  collection text NOT NULL,
  doc_id text,
  data jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
