-- 003: trip capacity enforced by the database.
--
--   trips.seats_taken  integer NOT NULL DEFAULT 0   (document field seatsTaken, readable by everyone like the rest of trips)
--   = sum of seats of the trip's trip_registrations whose status is pending|confirmed, kept up to date by triggers.
--
-- A booking that would push seats_taken past the trip's capacity (when capacity is a positive number) fails with
-- SQLSTATE FL001 "This yatra is full", which the store maps to failed-precondition. The trip row is locked while the
-- check runs, so concurrent bookings for the last seat take turns.
--
-- Legacy rows: values that did not fit a typed column live in "extra" (seats "3", status "Pending", capacity "40");
-- the helper functions read both places and mirror the client (seats = parseInt(seats) || 1, status lower-cased).
-- capacity NULL / 0 / negative = unlimited.

ALTER TABLE "trips" ADD COLUMN "seats_taken" integer NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD CONSTRAINT "trips_seats_taken_chk" CHECK ("seats_taken" >= 0);
COMMENT ON COLUMN "trips"."seats_taken" IS 'document field "seatsTaken": trigger-maintained, never written by clients';

-- An integer from a typed column, else from a number / numeric-looking string kept in extra (parseInt-like); NULL when neither.
CREATE OR REPLACE FUNCTION folk_int_of(col integer, extra jsonb, k text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN col IS NOT NULL THEN col
    WHEN jsonb_typeof(extra -> k) = 'number' THEN LEAST(GREATEST(trunc((extra ->> k)::numeric), -2000000000), 2000000000)::integer
    WHEN jsonb_typeof(extra -> k) = 'string' AND (extra ->> k) ~ '^\s*[+-]?[0-9]{1,9}' THEN substring(extra ->> k from '^\s*([+-]?[0-9]{1,9})')::integer
    ELSE NULL
  END
$$;

-- Seats a booking holds: parseInt(seats) || 1 (never less than 1).
CREATE OR REPLACE FUNCTION folk_reg_seats(seats integer, extra jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(COALESCE(NULLIF(folk_int_of(seats, extra, 'seats'), 0), 1), 1)
$$;

-- Does the booking hold seats (pending or confirmed, case-insensitive)?
CREATE OR REPLACE FUNCTION folk_reg_held(status text, extra jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(COALESCE(status, CASE WHEN jsonb_typeof(extra -> 'status') = 'string' THEN extra ->> 'status' END, '')) IN ('pending', 'confirmed')
$$;

-- Seats held on a trip, optionally leaving one booking out.
CREATE OR REPLACE FUNCTION folk_trip_seats_taken(p_trip text, p_exclude text DEFAULT NULL) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(folk_reg_seats(seats, extra)), 0)::integer
  FROM trip_registrations
  WHERE trip_id = p_trip AND folk_reg_held(status, extra) AND (p_exclude IS NULL OR id <> p_exclude)
$$;

-- Backfill before the triggers exist.
UPDATE "trips" SET "seats_taken" = folk_trip_seats_taken("id");

-- trips: seats_taken is derived, whatever a writer puts there is replaced.
CREATE OR REPLACE FUNCTION folk_trips_seats_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.seats_taken := folk_trip_seats_taken(NEW.id);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trips_seats_guard ON "trips";
CREATE TRIGGER trips_seats_guard BEFORE INSERT OR UPDATE ON "trips"
  FOR EACH ROW EXECUTE FUNCTION folk_trips_seats_guard();

-- trip_registrations, BEFORE: refuse a booking that takes seats the trip does not have.
CREATE OR REPLACE FUNCTION folk_trip_registration_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old trip_registrations%ROWTYPE;
  v_new_seats integer;
  v_old_seats integer := 0;
  v_cap integer;
  v_taken integer;
  v_left integer;
  v_extra jsonb;
BEGIN
  IF current_setting('folk.import', true) = 'on' THEN RETURN NEW; END IF; -- bulk imports of existing data
  IF NEW.trip_id IS NULL OR NOT folk_reg_held(NEW.status, NEW.extra) THEN RETURN NEW; END IF; -- cancelled / waitlisted: holds nothing

  -- What this very booking held before the write (an UPDATE, or an INSERT .. ON CONFLICT DO UPDATE of an existing id).
  SELECT * INTO v_old FROM trip_registrations WHERE id = NEW.id;
  IF FOUND AND v_old.trip_id IS NOT DISTINCT FROM NEW.trip_id AND folk_reg_held(v_old.status, v_old.extra) THEN
    v_old_seats := folk_reg_seats(v_old.seats, v_old.extra);
  END IF;
  v_new_seats := folk_reg_seats(NEW.seats, NEW.extra);
  IF v_new_seats <= v_old_seats THEN RETURN NEW; END IF; -- takes no extra seat (confirming, editing details, fewer seats)

  -- Serialise bookings of one trip: the second one waits here and then sees the first one's seats.
  SELECT capacity, extra INTO v_cap, v_extra FROM trips WHERE id = NEW.trip_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_cap := folk_int_of(v_cap, v_extra, 'capacity');
  IF v_cap IS NULL OR v_cap <= 0 THEN RETURN NEW; END IF; -- unlimited

  v_taken := folk_trip_seats_taken(NEW.trip_id, NEW.id);
  IF v_taken + v_new_seats > v_cap THEN
    v_left := GREATEST(v_cap - v_taken, 0);
    IF v_left = 0 THEN
      RAISE EXCEPTION 'This yatra is full' USING ERRCODE = 'FL001';
    END IF;
    RAISE EXCEPTION 'This yatra is full: only % seat% left', v_left, CASE WHEN v_left = 1 THEN '' ELSE 's' END USING ERRCODE = 'FL001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trip_registrations_capacity ON "trip_registrations";
CREATE TRIGGER trip_registrations_capacity BEFORE INSERT OR UPDATE ON "trip_registrations"
  FOR EACH ROW EXECUTE FUNCTION folk_trip_registration_capacity();

-- trip_registrations, AFTER: recompute seats_taken of the trip(s) touched (a moved booking touches two).
CREATE OR REPLACE FUNCTION folk_trip_registration_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_trip text;
BEGIN
  FOR v_trip IN
    SELECT DISTINCT t FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.trip_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.trip_id END
    ]) AS t WHERE t IS NOT NULL ORDER BY t
  LOOP
    PERFORM 1 FROM trips WHERE id = v_trip FOR UPDATE; -- lock first, so the sum below is taken after earlier bookings committed
    UPDATE trips SET seats_taken = folk_trip_seats_taken(v_trip)
      WHERE id = v_trip AND seats_taken IS DISTINCT FROM folk_trip_seats_taken(v_trip);
  END LOOP;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS trip_registrations_sync ON "trip_registrations";
CREATE TRIGGER trip_registrations_sync AFTER INSERT OR DELETE OR UPDATE OF trip_id, seats, status, extra ON "trip_registrations"
  FOR EACH ROW EXECUTE FUNCTION folk_trip_registration_sync();
