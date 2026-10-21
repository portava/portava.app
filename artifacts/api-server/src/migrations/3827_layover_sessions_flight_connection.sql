-- 3827_layover_sessions_flight_connection.sql
--
-- Layover spec §4 `layover_sessions` (census-layover L21), §4.1 `LayoverState`
-- (L33), §24 "Replan fanout: index active sessions by airport/route/flight
-- subjects" (L259), §25 "Trips: detect connection; show Layover card/status;
-- pass flight segments into session creation" (L267). Layover 165 program,
-- lane B1-F. Owner decision 2026-10-18 (flight data): detection from the
-- traveller's own Trips itinerary; a session linked to BOTH flight segments.
--
-- WHAT §4 ASKS FOR, AND WHAT THIS FILE ADDS
-- =========================================
-- §4: layover_sessions (id, user_id, trip_id, airport_place_id,
-- arrival_segment_id, departure_segment_id, state, connection_type,
-- detected_source, started_at, expires_at, active_snapshot_id,
-- confidence_band, created_at, updated_at). 0127 holds id, user_id, trip_id,
-- an airport reference (airport_id), started_at's instant (created_at) and the
-- two timestamps. This file adds six:
--
--   arrival_segment_id    -> trip_transport_segments(id), ON DELETE SET NULL:
--   departure_segment_id     the Trips flight segments (3826) the connection is
--                            between. Trips owns them (§3); a traveller removing
--                            a flight from the trip unlinks the session rather
--                            than deleting it or failing the removal.
--   state                 §4.1's seventeen LayoverState members, TEXT + CHECK.
--                         `status` (0127/2741) stays the operational column
--                         every reader filters on; `state` is the lifecycle.
--   connection_type       single_booking | separate_bookings | unknown — what
--                         the two segments' booking references SAY, nothing
--                         more: equal references are one booking; two different
--                         references are two bookings (a self-transfer, §21.1's
--                         "5h self-transfer"); a missing one is unknown. It is
--                         not a claim that a carrier protects the connection.
--   detected_source       manual (the Layover sheet: typed times) |
--                         trip_itinerary (detected from the traveller's Trips
--                         flight segments, LayoverConnectionDetection.ts). The
--                         trigger stamps `manual` on a session born with no
--                         segment link: the Layover sheet is the only other
--                         creator, so that is a fact, not a guess.
--   expires_at            the instant the session times out (§5 "Any active
--                         state -> timeout -> EXPIRED"): its departure_time,
--                         which is exactly the expiry sweep's own predicate
--                         (LayoverSessionService.expireOldSessions). Maintained
--                         by the trigger below, so it cannot drift from it.
-- active_snapshot_id and confidence_band are 3828's: their producer is the
-- certified-computation store (2700 + 3623), which production has not applied,
-- and this file must not wait on that press.
--
-- STATE IS SERVER-AUTHORITATIVE (§19.1 "computed ... and certification fields
-- are server-controlled"), and this file writes it where the status says it:
--   * a session is born DETECTED (§5's first state) unless born ended;
--   * a status write carries its state: returning -> RETURNING; completed,
--     cancelled, expired -> COMPLETED, CANCELLED, EXPIRED; an ended session's
--     state is always its terminal state;
--   * the states between (NEEDS_INFO ... AIRPORT_REENTERED, BOARDING, DISRUPTED,
--     CANCELLED for a cancelled departure) are written by the API's lifecycle
--     projection and the flight-status adapter, as the service role.
-- A client role (anon, authenticated) may not set or change any of the six
-- columns: 0127's FOR ALL owner policy is column-blind and 3620 (which removes
-- the client write grant) is not applied everywhere, so the guard is here,
-- refused with 42501. The guard and the derivation are one SECURITY INVOKER
-- trigger: layover_sessions_connection_guard.
--
-- THE FLIGHT-SUBJECT AXIS (L259). 2986 indexed the airport axis. A §11 flight
-- event names a flight (a Trips segment id); the replan port reads the active
-- sessions linked to it by `arrival_segment_id = ANY($1)` and
-- `departure_segment_id = ANY($1)` (LayoverExternalReplanPort's flight read).
-- Two partial indexes, one per column, NOT NULL-partial so they also serve the
-- foreign keys' ON DELETE SET NULL lookups when a segment is removed. The ROUTE
-- axis is NOT added: a session has no route column and nothing could populate
-- one (census L259's own finding), so it is named here rather than invented.
--
-- ONE LIVE SESSION PER CONNECTION PER TRAVELLER: a unique partial index on
-- (user_id, arrival_segment_id, departure_segment_id) over the live statuses,
-- so a double tap on "Start this layover" cannot open two sessions.
--
-- FLAG: `layover_flight_connections_enabled`, seeded FALSE. OFF / absent: the
-- API writes and reads none of these columns and every response is what it was;
-- the trigger still stamps DETECTED/terminal states and expires_at on rows the
-- API writes, which no reader looks at. ON: detection, segment-linked session
-- creation, the flight-subject fan-out and the stored lifecycle state.
--
-- ORDER: depends on 0127, 2741 ('returning') and 3826 (the segment columns).
-- Nothing numbered above 3827 alters layover_sessions or trip_transport_segments:
-- 3900 and 3996 only add foreign keys INTO layover_sessions(id) and write no
-- session row (grep evidence in the lane handback).
--
-- Rollback: db/rollback/2026-10-18-3827-layover-sessions-flight-connection-rollback.sql
-- (refuses while a session holds a segment link, a connection type, a detected
-- source or a state the trigger did not derive; and while the flag is ON or
-- has audit history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): public.layover_sessions does not exist (0127)';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): public.feature_flags does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.layover_sessions'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%returning%') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): layover_sessions.status does not admit returning (2741)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_transport_segments' AND column_name = 'carrier_code') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): trip_transport_segments has no flight columns (3826)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_sessions'
                AND column_name IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type',
                                    'detected_source', 'expires_at')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): a connection column already exists on layover_sessions';
  END IF;
END
$pre$;

ALTER TABLE public.layover_sessions
  ADD COLUMN arrival_segment_id   uuid        NULL
    CONSTRAINT layover_sessions_arrival_segment_id_fkey REFERENCES public.trip_transport_segments(id) ON DELETE SET NULL,
  ADD COLUMN departure_segment_id uuid        NULL
    CONSTRAINT layover_sessions_departure_segment_id_fkey REFERENCES public.trip_transport_segments(id) ON DELETE SET NULL,
  ADD COLUMN state                text        NULL,
  ADD COLUMN connection_type      text        NULL,
  ADD COLUMN detected_source      text        NULL,
  ADD COLUMN expires_at           timestamptz NULL,
  ADD CONSTRAINT layover_sessions_state_known
    CHECK (state IS NULL OR state IN ('DETECTED','NEEDS_INFO','EVALUATING','AIRPORT_ONLY','LANDSIDE_AVAILABLE',
                                      'PLAN_SELECTED','EXECUTING','RETURN_SOON','RETURN_NOW','RETURNING',
                                      'AIRPORT_REENTERED','BOARDING','COMPLETED','DISRUPTED','CANCELLED',
                                      'ABANDONED','EXPIRED')),
  ADD CONSTRAINT layover_sessions_connection_type_known
    CHECK (connection_type IS NULL OR connection_type IN ('single_booking','separate_bookings','unknown')),
  ADD CONSTRAINT layover_sessions_detected_source_known
    CHECK (detected_source IS NULL OR detected_source IN ('manual','trip_itinerary')),
  -- A connection is between two DIFFERENT flights. Not "both or neither": a
  -- removed segment nulls one side (ON DELETE SET NULL) and must not fail.
  ADD CONSTRAINT layover_sessions_segments_distinct
    CHECK (arrival_segment_id IS NULL OR departure_segment_id IS NULL OR arrival_segment_id <> departure_segment_id);

COMMENT ON COLUMN public.layover_sessions.state IS
  '3827 (Layover §4.1, census-layover L33): the seventeen LayoverState members. DETECTED at birth; RETURNING/COMPLETED/CANCELLED/EXPIRED from the status (trigger layover_sessions_connection_guard); the states between from the API lifecycle projection and the flight-status adapter. NULL = not recorded (a session from before 3827). Server-only.';
COMMENT ON COLUMN public.layover_sessions.arrival_segment_id IS
  '3827 (census-layover L21/L267): the Trips flight segment (trip_transport_segments, 3826) the traveller arrives on. NULL for a session started by hand, or after the segment was removed from the trip.';
COMMENT ON COLUMN public.layover_sessions.departure_segment_id IS
  '3827: the Trips flight segment the traveller departs on. See arrival_segment_id.';
COMMENT ON COLUMN public.layover_sessions.connection_type IS
  '3827: single_booking | separate_bookings | unknown, from the two segments'' booking references and nothing else. Not a claim of carrier protection.';
COMMENT ON COLUMN public.layover_sessions.detected_source IS
  '3827: manual (typed in the Layover sheet) | trip_itinerary (detected from the traveller''s Trips flight segments).';
COMMENT ON COLUMN public.layover_sessions.expires_at IS
  '3827: when the session times out = its departure_time, the expiry sweep''s own predicate. Maintained by layover_sessions_connection_guard.';

CREATE OR REPLACE FUNCTION public.layover_sessions_connection_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- §19.1: the connection, the source and the lifecycle are server-controlled.
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.arrival_segment_id IS NOT NULL OR NEW.departure_segment_id IS NOT NULL OR NEW.state IS NOT NULL
         OR NEW.connection_type IS NOT NULL OR NEW.detected_source IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
        RAISE EXCEPTION 'layover_sessions: the flight connection, its source and the lifecycle state are written by the server only (3827)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.arrival_segment_id IS DISTINCT FROM OLD.arrival_segment_id
       OR NEW.departure_segment_id IS DISTINCT FROM OLD.departure_segment_id
       OR NEW.state IS DISTINCT FROM OLD.state
       OR NEW.connection_type IS DISTINCT FROM OLD.connection_type
       OR NEW.detected_source IS DISTINCT FROM OLD.detected_source
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'layover_sessions: the flight connection, its source and the lifecycle state are written by the server only (3827)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- §5: an ended session is in its terminal state; RETURNING is the stored status 2741 added.
  IF NEW.status IN ('completed', 'cancelled', 'expired') THEN
    NEW.state := upper(NEW.status);
  ELSIF NEW.status = 'returning' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'returning') THEN
    NEW.state := 'RETURNING';
  ELSIF TG_OP = 'INSERT' AND NEW.state IS NULL THEN
    NEW.state := 'DETECTED';
  END IF;

  -- A session born with no Trips flight segment was typed into the Layover sheet: the only other creator.
  IF TG_OP = 'INSERT' AND NEW.detected_source IS NULL AND NEW.arrival_segment_id IS NULL AND NEW.departure_segment_id IS NULL THEN
    NEW.detected_source := 'manual';
  END IF;

  -- §5 timeout: the expiry sweep retires a live session once its departure has passed.
  IF TG_OP = 'INSERT' OR NEW.departure_time IS DISTINCT FROM OLD.departure_time OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    NEW.expires_at := NEW.departure_time;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_sessions_connection_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS layover_sessions_connection_guard ON public.layover_sessions;
CREATE TRIGGER layover_sessions_connection_guard
  BEFORE INSERT OR UPDATE ON public.layover_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.layover_sessions_connection_guard();

-- L259: the flight-subject axis of the replan fan-out (and the FK SET NULL lookups).
CREATE INDEX layover_sessions_arrival_segment_idx
  ON public.layover_sessions (arrival_segment_id) WHERE arrival_segment_id IS NOT NULL;
CREATE INDEX layover_sessions_departure_segment_idx
  ON public.layover_sessions (departure_segment_id) WHERE departure_segment_id IS NOT NULL;

-- One live session per traveller per connection.
CREATE UNIQUE INDEX layover_sessions_live_connection_uidx
  ON public.layover_sessions (user_id, arrival_segment_id, departure_segment_id)
  WHERE status IN ('active', 'returning') AND arrival_segment_id IS NOT NULL AND departure_segment_id IS NOT NULL;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('layover_flight_connections_enabled', false,
   '3827 (Layover §3/§4/§24/§25, census-layover L11/L21/L33/L259/L267): flight-data connections. OFF / absent: no connection is detected, no session is linked to a Trips flight segment, the replan fan-out has no flight axis and the API writes no lifecycle state; every response is what it was. ON: GET/POST /trips/:tripId/layover-connections detect a connection from the traveller''s Trips flight segments and start a DETECTED session linked to both; a flight-status update recalculates the linked sessions.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE t text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_sessions'
         AND column_name IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type',
                             'detected_source', 'expires_at')
         AND is_nullable = 'YES') <> 6 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): the six nullable connection columns are not all present';
  END IF;
  FOREACH t IN ARRAY ARRAY['layover_sessions_state_known', 'layover_sessions_connection_type_known',
                           'layover_sessions_detected_source_known', 'layover_sessions_segments_distinct'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass
                    AND conname = t AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3827): CHECK % missing or not validated', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['layover_sessions_arrival_segment_id_fkey', 'layover_sessions_departure_segment_id_fkey'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass AND conname = t
                    AND contype = 'f' AND confrelid = 'public.trip_transport_segments'::regclass AND confdeltype = 'n') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3827): % must reference trip_transport_segments ON DELETE SET NULL', t;
    END IF;
  END LOOP;
  IF to_regclass('public.layover_sessions_arrival_segment_idx') IS NULL
     OR to_regclass('public.layover_sessions_departure_segment_idx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): a flight-subject index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'layover_sessions_live_connection_uidx' AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): layover_sessions_live_connection_uidx is missing or not unique';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.layover_sessions_connection_guard()'::regprocedure
                    AND NOT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): layover_sessions_connection_guard must be SECURITY INVOKER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.layover_sessions_connection_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.layover_sessions_connection_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): a client role may execute layover_sessions_connection_guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.layover_sessions'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
                    AND tgname = 'layover_sessions_connection_guard'
                    AND tgfoid = 'public.layover_sessions_connection_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): the connection guard trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_flight_connections_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): layover_flight_connections_enabled is not seeded';
  END IF;
END
$post$;

COMMIT;
