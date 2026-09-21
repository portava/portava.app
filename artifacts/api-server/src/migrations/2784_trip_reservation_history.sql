-- 2784_trip_reservation_history.sql
--
-- Trips spec §15.4 (booking history is append-only; compensation is a new
-- state/event so replay stays accurate) and §18.3 (confirmed booking/time:
-- optimistic concurrency with an explicit conflict). census-trips TR297,
-- TR298, TR352.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- DELETE /trips/:tripId/reservations/:id issued a hard delete (TR297: "a
-- confirmed row deleted"); PATCH was last-write-wins with no version and no
-- If-Match (TR352); nothing represented compensation (TR298). trip_reservations
-- is a PRODUCTION table (0172), so everything here is additive and the route
-- behaviour that depends on it is behind trip_operational_projections_enabled
-- until an owner applies this file there (check:flag-schema-prerequisites).
--
-- WHAT THIS FILE DOES
-- ===================
--   trip_reservations.version        bumped by trigger on every UPDATE — the
--                                    row-level version §18.3 asks for.
--   trip_reservations.cancelled_at   set when status becomes 'cancelled'.
--   status vocabulary                + 'cancelled' (was pending_confirm |
--                                    confirmed | dismissed).
--   trip_reservation_events          append-only history: created / updated /
--                                    confirmed / dismissed / cancelled /
--                                    compensated, with from/to status, the
--                                    version after the change, the CHANGED KEYS
--                                    only (§5.3 minimised), and the actor when
--                                    the route names one (portava.actor GUC).
--                                    authenticated may SELECT; nobody UPDATEs
--                                    or DELETEs a history row (trigger), and a
--                                    reservation's history goes with it only
--                                    when the reservation itself goes (cascade
--                                    from an account deletion).
--   authenticated loses DELETE on trip_reservations: cancel is the client's
--   only way to remove one, which is §15.4 stated as a privilege.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_reservation_events') IS NOT NULL THEN
    RAISE EXCEPTION '2784: trip_reservation_events already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_reservations') IS NULL THEN
    RAISE EXCEPTION '2784: trip_reservations missing (0172)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_reservations_status_check') THEN
    RAISE EXCEPTION '2784: trip_reservations_status_check missing; the vocabulary this file extends is not the one it expects';
  END IF;
END
$pre$;

ALTER TABLE public.trip_reservations
  ADD COLUMN version      bigint      NOT NULL DEFAULT 0,
  ADD COLUMN cancelled_at timestamptz NULL,
  DROP CONSTRAINT trip_reservations_status_check,
  ADD CONSTRAINT trip_reservations_status_check CHECK (status IN ('pending_confirm', 'confirmed', 'dismissed', 'cancelled')),
  ADD CONSTRAINT trip_reservations_cancelled_agrees CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
COMMENT ON COLUMN public.trip_reservations.version IS 'Trips spec §18.3: row version, bumped by trigger on every UPDATE; PATCH honours If-Match against it and answers 409 TRIP_VERSION_CONFLICT on a mismatch.';
COMMENT ON COLUMN public.trip_reservations.cancelled_at IS 'Trips spec §15.4: a reservation is cancelled, never deleted by a client; cancel sets this and status = cancelled together (CHECK).';

CREATE TABLE public.trip_reservation_events (
  id             bigserial   PRIMARY KEY,
  reservation_id uuid        NOT NULL REFERENCES public.trip_reservations(id) ON DELETE CASCADE,
  trip_id        uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  event_type     text        NOT NULL,
  from_status    text        NULL,
  to_status      text        NULL,
  version        bigint      NOT NULL,
  actor_user_id  uuid        NULL,
  changed_keys   text[]      NOT NULL DEFAULT '{}',
  payload_json   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_reservation_events_type_known CHECK (event_type IN ('created', 'updated', 'confirmed', 'dismissed', 'cancelled', 'compensated'))
);
COMMENT ON TABLE public.trip_reservation_events IS
  'Trips spec §15.4 append-only booking history: one row per change to a trip_reservations row (trigger) and one per compensation (route), with from/to status, the version after the change and the changed keys — not the values (§5.3). UPDATE and DELETE on a history row are refused by trigger; rows leave only by cascade when the reservation is deleted by the service (account deletion).';
CREATE INDEX idx_trip_reservation_events_reservation ON public.trip_reservation_events (reservation_id, id);

CREATE OR REPLACE FUNCTION public.trip_reservation_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'trip_reservation_events is append-only (Trips spec §15.4): % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;
CREATE TRIGGER trip_reservation_events_no_update
  BEFORE UPDATE ON public.trip_reservation_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_reservation_events_append_only();
-- DELETE by cascade must still work, so the delete guard refuses only direct deletes:
-- a cascade runs with the parent already gone.
CREATE OR REPLACE FUNCTION public.trip_reservation_events_no_direct_delete()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trip_reservations r WHERE r.id = OLD.reservation_id) THEN
    RAISE EXCEPTION 'trip_reservation_events is append-only (Trips spec §15.4): DELETE refused while the reservation exists'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER trip_reservation_events_no_delete
  BEFORE DELETE ON public.trip_reservation_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_reservation_events_no_direct_delete();

-- The history writer. `portava.actor` is a transaction-local GUC the route sets
-- (set_config('portava.actor', <uuid>, true)) so the row names who acted;
-- absent, actor_user_id is null and the row still exists.
CREATE OR REPLACE FUNCTION public.trip_reservations_history()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  keys text[] := '{}';
  k text;
  et text;
  actor uuid;
BEGIN
  BEGIN
    actor := NULLIF(current_setting('portava.actor', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN actor := NULL; END;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.trip_reservation_events (reservation_id, trip_id, event_type, from_status, to_status, version, actor_user_id, changed_keys)
    VALUES (NEW.id, NEW.trip_id, 'created', NULL, NEW.status, NEW.version, actor, '{}');
    RETURN NEW;
  END IF;
  -- UPDATE: bump the version, then record what changed (keys only).
  NEW.version := OLD.version + 1;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN NEW.cancelled_at := coalesce(NEW.cancelled_at, now()); END IF;
  FOR k IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
    IF k NOT IN ('version', 'updated_at') AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN keys := array_append(keys, k); END IF;
  END LOOP;
  et := CASE
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'confirmed' THEN 'confirmed'
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'dismissed' THEN 'dismissed'
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled' THEN 'cancelled'
    ELSE 'updated' END;
  INSERT INTO public.trip_reservation_events (reservation_id, trip_id, event_type, from_status, to_status, version, actor_user_id, changed_keys)
  VALUES (NEW.id, NEW.trip_id, et, OLD.status, NEW.status, NEW.version, actor, keys);
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER trip_reservations_history_insert
  AFTER INSERT ON public.trip_reservations
  FOR EACH ROW EXECUTE FUNCTION public.trip_reservations_history();
CREATE TRIGGER trip_reservations_history_update
  BEFORE UPDATE ON public.trip_reservations
  FOR EACH ROW EXECUTE FUNCTION public.trip_reservations_history();

-- Compensation (§15.4): a NEW event, recorded by the route with amount/currency/note; the reservation row is untouched.
CREATE OR REPLACE FUNCTION public.trip_reservation_record_compensation(p_reservation_id uuid, p_actor uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_catalog' AS $fn$
DECLARE r public.trip_reservations%ROWTYPE; v_id bigint;
BEGIN
  SELECT * INTO r FROM public.trip_reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_BOOKING_NOT_FOUND'); END IF;
  IF r.status <> 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_BOOKING_HISTORY_APPEND_ONLY', 'detail', 'compensation is recorded against a cancelled reservation'); END IF;
  IF p_payload ? 'lat' OR p_payload ? 'lng' THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'coordinates are not compensation'); END IF;
  INSERT INTO public.trip_reservation_events (reservation_id, trip_id, event_type, from_status, to_status, version, actor_user_id, changed_keys, payload_json)
  VALUES (r.id, r.trip_id, 'compensated', r.status, r.status, r.version, p_actor, '{}', coalesce(p_payload, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'event_id', v_id, 'version', r.version);
END;
$fn$;
REVOKE ALL ON FUNCTION public.trip_reservation_record_compensation(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.trip_reservation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_reservation_events_crew_select ON public.trip_reservation_events
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_reservation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_reservation_events TO authenticated;
GRANT USAGE ON SEQUENCE public.trip_reservation_events_id_seq TO service_role;

-- §15.4 as a privilege: clients cancel; only the service deletes (account deletion).
DROP POLICY IF EXISTS trip_reservations_owner_delete ON public.trip_reservations;
REVOKE DELETE ON public.trip_reservations FROM authenticated;

DO $post$
DECLARE n int; r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.trip_reservations'::regclass AND tgname = 'trip_reservations_history_update') THEN RAISE EXCEPTION '2784: history trigger missing'; END IF;
  IF has_table_privilege('authenticated', 'public.trip_reservations', 'DELETE') THEN RAISE EXCEPTION '2784: authenticated still deletes reservations'; END IF;
  IF has_table_privilege('authenticated', 'public.trip_reservation_events', 'UPDATE') OR has_table_privilege('authenticated', 'public.trip_reservation_events', 'DELETE') THEN RAISE EXCEPTION '2784: authenticated writes history'; END IF;
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_reservation_events'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2784: RLS not enabled on history'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_reservations_status_check' AND pg_get_constraintdef(oid) LIKE '%cancelled%') THEN RAISE EXCEPTION '2784: status vocabulary lacks cancelled'; END IF;
END
$post$;

COMMIT;
