-- 3826_trip_kernel_flight_segments.sql
--
-- Layover spec §3 "Trips owns flight segments, itinerary relationships, user
-- trip context" (census-layover L11, L267; Layover 165 program, lane B1-F).
-- Owner decision 2026-10-18: "a flight-segment model that Trips owns. If Trips
-- already has legs, make flight segments first-class there, with carrier,
-- flight number, scheduled and estimated departure/arrival, terminal, gate and
-- status." Unknown flight information stays EXPLICITLY unknown.
--
-- WHERE THE SEGMENT LIVES, AND WHY THERE
-- ======================================
-- Trips already has its §15.1 TransportSegment, `trip_transport_segments`
-- (2782, applied to production): mode 'flight', the planned departure/arrival
-- pair (the SCHEDULED times), from/to, booking_ref, an optional trip_leg and
-- trip_stage, a state machine, and one writer — public.trip_kernel_execute
-- (ADD_/UPDATE_/REMOVE_TRANSPORT_SEGMENT, SET_TRANSPORT_STATE). A second
-- flight table beside it would be two sources of truth for one flight. So the
-- flight facts become COLUMNS of that segment, written by the same kernel:
--
--   itinerary (what was booked; written by ADD_TRANSPORT_SEGMENT)
--     carrier_code, flight_number             the designator, split: 'BA' + '286'
--     departure_airport_iata, arrival_airport_iata
--     planned_departure_at, planned_arrival_at (2782's, unchanged: SCHEDULED)
--     booking_ref                              (2782's, unchanged)
--   operation (what the flight is DOING; written by RECORD_FLIGHT_STATUS)
--     estimated_departure_at, estimated_arrival_at
--     departure_terminal, arrival_terminal, departure_gate, arrival_gate
--     flight_status        unknown | scheduled | delayed | boarding | departed
--                          | landed | cancelled | diverted
--     flight_status_source traveller | feed
--     flight_status_observed_at
--
-- (A traveller who knows their terminal or gate from a boarding pass may also
-- state them on ADD_TRANSPORT_SEGMENT; after that they move only through
-- RECORD_FLIGHT_STATUS, which carries a source and an instant.)
--
-- UNKNOWN IS A VALUE, NOT A DEFAULT
-- =================================
--   * an estimate nobody stated is NULL — never the scheduled time copied in.
--     A reader that wants "the best known departure" must say which it used
--     (domain/trips/services/TripFlightSegments.ts#bestKnownDeparture).
--   * a flight segment's status starts as the word 'unknown' (ADD writes it;
--     RECORD_FLIGHT_STATUS with `flight_status: null` writes it back), not
--     'scheduled': a status nobody observed is not evidence of anything.
--   * every flight column is NULL on a non-flight segment (CHECK below).
--
-- RECORD_FLIGHT_STATUS (the kernel, 2764's transform method)
-- ==========================================================
-- Capability 'engine' (2786's): an accepted crew member (actor_role 'user') or
-- the system actor (actor_role 'system', no user) — the two producers the owner
-- approved: the traveller, and an approved flight-status feed behind
-- services/airport/LayoverFlightStatus.ts. Each source is BOUND to its role: a
-- user may only record source 'traveller', the system only 'feed'. An
-- observation OLDER than the one the segment holds is refused by name,
-- TRIP_FLIGHT_STATUS_STALE — a late-arriving feed message can never overwrite
-- a newer one. A key present in the payload is a statement (null included, which
-- records "unknown"); a key absent leaves the column as it was. The event is
-- 2782's own `trip.transport_segment_updated` (family 'transport', command_type
-- RECORD_FLIGHT_STATUS in the payload), so 2787's snapshot fold already names it
-- and no event vocabulary changes. The result carries the segment and the
-- `previous` operational values, so a caller sees exactly what moved.
--
-- ADD_TRANSPORT_SEGMENT now writes the eight itinerary columns, sets
-- flight_status 'unknown' on a flight, and REFUSES a payload that names an
-- estimate or a status: those have a source and an instant, and ADD has neither.
--
-- WHAT THIS DOES NOT DO
-- =====================
--   * It does not detect connections or create layover sessions. That is the
--     Layover domain's (3827, services/airport/LayoverConnectionDetection.ts);
--     §3: Trips "must not own layover safety calculations".
--   * It calls no flight feed. No feed is licensed; the adapter that would
--     record one is complete and refuses by name until a credential exists.
--   * UPDATE_TRANSPORT_SEGMENT's patch is unchanged: a wrong flight is removed
--     and added again, and the itinerary CHECKs below refuse a patch that would
--     turn a flight into a walk while it still carries flight facts.
--
-- FLAG: `trip_flight_segments_enabled`, seeded FALSE. It gates the typed Trips
-- route that issues these commands (server/trips/flightSegmentRoute.ts) and the
-- flight read; the kernel itself is never flag-gated (commandRoute.ts's rule).
-- The flag row's existence is also how code deployed before this file knows the
-- columns are there: absent reads as off.
--
-- ORDER: depends on 2782 (the table and the transport family) and 2786 (the
-- 'engine' capability). Nothing numbered above 3826 alters trip_transport_segments,
-- and the only later kernel transform, 3979 (3974's re-issue), anchors on
-- `v_rec_day`, the admin-hide command's dispatch entry and its branch — none of
-- which this file touches — and counts its branches RELATIVE to the kernel in
-- front of it. Measured on PGlite (packet replica, PostgreSQL 18.3):
-- the kernel is byte-identical whether this file runs at 3826 (a fresh replay)
-- or after 3999 (portava-ci and production). Evidence in the lane handback.
--
-- Rollback: db/rollback/2026-10-18-3826-trip-kernel-flight-segments-rollback.sql
-- (refuses while any segment holds a flight fact, while the flag is ON or has
-- audit history, and while 3827 is installed).

BEGIN;

DO $pre$
DECLARE d text;
BEGIN
  IF to_regclass('public.trip_transport_segments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): public.trip_transport_segments does not exist (2782)';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): public.feature_flags does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trip_transport_segments'
                AND column_name IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                                    'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal',
                                    'arrival_terminal', 'departure_gate', 'arrival_gate', 'flight_status',
                                    'flight_status_source', 'flight_status_observed_at')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): a flight column already exists on trip_transport_segments';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3826): trip_kernel_execute not found'; END IF;
  IF position('ADD_TRANSPORT_SEGMENT' in d) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): the installed kernel predates 2782 (no transport family)';
  END IF;
  IF position($a$WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN 'engine'$a$ in d) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): the installed kernel predates 2786 (no engine capability)';
  END IF;
  IF position('RECORD_FLIGHT_STATUS' in d) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826): RECORD_FLIGHT_STATUS is already present; this migration is not idempotent by design';
  END IF;
END
$pre$;

-- ── the flight facts, on the Trips segment ──────────────────────────────────
ALTER TABLE public.trip_transport_segments
  ADD COLUMN carrier_code              text        NULL,
  ADD COLUMN flight_number             text        NULL,
  ADD COLUMN departure_airport_iata    text        NULL,
  ADD COLUMN arrival_airport_iata      text        NULL,
  ADD COLUMN estimated_departure_at    timestamptz NULL,
  ADD COLUMN estimated_arrival_at      timestamptz NULL,
  ADD COLUMN departure_terminal        text        NULL,
  ADD COLUMN arrival_terminal          text        NULL,
  ADD COLUMN departure_gate            text        NULL,
  ADD COLUMN arrival_gate              text        NULL,
  ADD COLUMN flight_status             text        NULL,
  ADD COLUMN flight_status_source      text        NULL,
  ADD COLUMN flight_status_observed_at timestamptz NULL,
  -- The carrier half of lib/providers/flightItineraryProvider.ts's DESIGNATOR_RE:
  -- three ICAO letters, or two IATA characters that are not both digits.
  ADD CONSTRAINT trip_transport_carrier_code_format
    CHECK (carrier_code IS NULL OR carrier_code ~ '^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])$'),
  -- The number half, canonical: 1-4 digits, no leading zero ('BA0286' is BA286).
  ADD CONSTRAINT trip_transport_flight_number_format
    CHECK (flight_number IS NULL OR flight_number ~ '^[1-9][0-9]{0,3}$'),
  ADD CONSTRAINT trip_transport_airports_iata
    CHECK ((departure_airport_iata IS NULL OR departure_airport_iata ~ '^[A-Z]{3}$')
       AND (arrival_airport_iata IS NULL OR arrival_airport_iata ~ '^[A-Z]{3}$')),
  ADD CONSTRAINT trip_transport_airports_distinct
    CHECK (departure_airport_iata IS NULL OR arrival_airport_iata IS NULL OR departure_airport_iata <> arrival_airport_iata),
  -- TEXT, 2992's reasoning for layover_constraints: '2', '2E', 'S4', 'Satellite 1'.
  ADD CONSTRAINT trip_transport_terminals_gates_length
    CHECK ((departure_terminal IS NULL OR length(departure_terminal) BETWEEN 1 AND 32)
       AND (arrival_terminal   IS NULL OR length(arrival_terminal)   BETWEEN 1 AND 32)
       AND (departure_gate     IS NULL OR length(departure_gate)     BETWEEN 1 AND 32)
       AND (arrival_gate       IS NULL OR length(arrival_gate)       BETWEEN 1 AND 32)),
  ADD CONSTRAINT trip_transport_estimated_ordered
    CHECK (estimated_departure_at IS NULL OR estimated_arrival_at IS NULL OR estimated_arrival_at >= estimated_departure_at),
  ADD CONSTRAINT trip_transport_flight_status_known
    CHECK (flight_status IS NULL OR flight_status IN ('unknown','scheduled','delayed','boarding','departed','landed','cancelled','diverted')),
  ADD CONSTRAINT trip_transport_flight_status_source_known
    CHECK (flight_status_source IS NULL OR flight_status_source IN ('traveller','feed')),
  -- An observation has a source and an instant, or neither.
  ADD CONSTRAINT trip_transport_flight_status_provenance
    CHECK ((flight_status_source IS NULL) = (flight_status_observed_at IS NULL)),
  -- A walk has no gate.
  ADD CONSTRAINT trip_transport_flight_fields_only_on_flights
    CHECK (mode = 'flight' OR (carrier_code IS NULL AND flight_number IS NULL AND departure_airport_iata IS NULL
                               AND arrival_airport_iata IS NULL AND estimated_departure_at IS NULL AND estimated_arrival_at IS NULL
                               AND departure_terminal IS NULL AND arrival_terminal IS NULL AND departure_gate IS NULL
                               AND arrival_gate IS NULL AND flight_status IS NULL AND flight_status_source IS NULL
                               AND flight_status_observed_at IS NULL));

COMMENT ON COLUMN public.trip_transport_segments.carrier_code IS
  '3826 (Layover §3, census-layover L11): airline designator (IATA two-character or ICAO three-letter). With flight_number, the flight. NULL = not stated.';
COMMENT ON COLUMN public.trip_transport_segments.estimated_departure_at IS
  '3826: the departure the latest observation states (RECORD_FLIGHT_STATUS, with flight_status_source/_observed_at). NULL = no estimate stated, NEVER "on time"; planned_departure_at is the SCHEDULED time.';
COMMENT ON COLUMN public.trip_transport_segments.flight_status IS
  '3826: unknown | scheduled | delayed | boarding | departed | landed | cancelled | diverted. A flight segment starts unknown; only RECORD_FLIGHT_STATUS moves it.';

-- The feed's flight identity (designator + scheduled departure) -> the Trips segments that carry it.
CREATE INDEX idx_trip_transport_segments_flight
  ON public.trip_transport_segments (carrier_code, flight_number, planned_departure_at)
  WHERE mode = 'flight' AND carrier_code IS NOT NULL AND flight_number IS NOT NULL;

-- ── the kernel transform ────────────────────────────────────────────────────
DO $mig$
DECLARE
  d text;
  dn text;
  n int;
  before_len int;
  branches_before int;
  branches_after int;
  family_before int;
  family_after int;
  v_dispatch   constant text := $a$    WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN 'engine'$a$;
  v_dispatch2  constant text := $a$    WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN 'engine' WHEN 'RECORD_FLIGHT_STATUS' THEN 'engine'$a$;
  v_add_head   constant text := E'      WHEN ''ADD_TRANSPORT_SEGMENT'' THEN\n';
  v_add_head2  constant text := E'      WHEN ''ADD_TRANSPORT_SEGMENT'' THEN\n'
    || $r$        IF v_payload ?| ARRAY['estimated_departure_at', 'estimated_arrival_at', 'flight_status', 'flight_status_source', 'flight_status_observed_at'] THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'a flight''s estimates and status are recorded through RECORD_FLIGHT_STATUS, with their source', 'contract_version', 2);
        END IF;
$r$;
  v_cols       constant text := '             planned_departure_at, planned_arrival_at, party_size, reliability, cost_minor, currency, booking_ref, fallback_of, created_by)';
  v_cols2      constant text := '             planned_departure_at, planned_arrival_at, party_size, reliability, cost_minor, currency, booking_ref, fallback_of, created_by,' || E'\n'
                             || '             carrier_code, flight_number, departure_airport_iata, arrival_airport_iata,' || E'\n'
                             || '             departure_terminal, arrival_terminal, departure_gate, arrival_gate, flight_status)';
  v_vals       constant text := $a$(v_payload->>'fallback_of')::uuid, v_actor)$a$;
  v_vals2      constant text := $a$(v_payload->>'fallback_of')::uuid, v_actor,
                  v_payload->>'carrier_code', v_payload->>'flight_number',
                  v_payload->>'departure_airport_iata', v_payload->>'arrival_airport_iata',
                  v_payload->>'departure_terminal', v_payload->>'arrival_terminal',
                  v_payload->>'departure_gate', v_payload->>'arrival_gate',
                  CASE WHEN v_payload->>'mode' = 'flight' THEN 'unknown' END)$a$;
  v_upd_head   constant text := $a$      WHEN 'UPDATE_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'REMOVE_TRANSPORT_SEGMENT' THEN$a$;
  v_branch     constant text := $branches$      WHEN 'RECORD_FLIGHT_STATUS' THEN
        -- 3826 (Layover §3 / census-layover L11): what the flight is DOING, recorded on the
        -- Trips segment with its source and the instant it was observed. Engine capability:
        -- a crew traveller (source 'traveller') or the system actor for an approved feed
        -- (source 'feed'); each source is bound to its role.
        BEGIN
          v_segment_id  := (v_payload->>'segment_id')::uuid;
          v_observed_at := (v_payload->>'observed_at')::timestamptz;
        EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'segment_id must be a uuid and observed_at an instant', 'contract_version', 2);
        END;
        IF v_segment_id IS NULL OR v_observed_at IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'segment_id and observed_at are required', 'contract_version', 2);
        END IF;
        IF (v_payload->>'source') IS DISTINCT FROM (CASE v_actor_role WHEN 'system' THEN 'feed' WHEN 'user' THEN 'traveller' END) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'source must be traveller for a user and feed for the system actor', 'contract_version', 2);
        END IF;
        IF v_observed_at > now() + interval '5 minutes' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'observed_at is in the future', 'contract_version', 2);
        END IF;
        IF NOT (v_payload ?| ARRAY['estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal', 'departure_gate', 'arrival_gate', 'flight_status']) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'the observation states nothing about the flight', 'contract_version', 2);
        END IF;
        SELECT * INTO v_segment FROM public.trip_transport_segments WHERE id = v_segment_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TRANSPORT_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_segment.mode <> 'flight' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'not a flight segment', 'contract_version', 2);
        END IF;
        IF v_segment.flight_status_observed_at IS NOT NULL AND v_observed_at < v_segment.flight_status_observed_at THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_FLIGHT_STATUS_STALE', 'observed_at', v_observed_at,
                                    'recorded_observed_at', v_segment.flight_status_observed_at, 'contract_version', 2);
        END IF;
        v_applied := jsonb_build_object(
          'estimated_departure_at', v_segment.estimated_departure_at, 'estimated_arrival_at', v_segment.estimated_arrival_at,
          'departure_terminal', v_segment.departure_terminal, 'arrival_terminal', v_segment.arrival_terminal,
          'departure_gate', v_segment.departure_gate, 'arrival_gate', v_segment.arrival_gate,
          'flight_status', v_segment.flight_status, 'flight_status_source', v_segment.flight_status_source,
          'flight_status_observed_at', v_segment.flight_status_observed_at);
        BEGIN
          UPDATE public.trip_transport_segments SET
            estimated_departure_at = CASE WHEN v_payload ? 'estimated_departure_at' THEN (v_payload->>'estimated_departure_at')::timestamptz ELSE estimated_departure_at END,
            estimated_arrival_at   = CASE WHEN v_payload ? 'estimated_arrival_at'   THEN (v_payload->>'estimated_arrival_at')::timestamptz   ELSE estimated_arrival_at END,
            departure_terminal     = CASE WHEN v_payload ? 'departure_terminal'     THEN v_payload->>'departure_terminal'                    ELSE departure_terminal END,
            arrival_terminal       = CASE WHEN v_payload ? 'arrival_terminal'       THEN v_payload->>'arrival_terminal'                      ELSE arrival_terminal END,
            departure_gate         = CASE WHEN v_payload ? 'departure_gate'         THEN v_payload->>'departure_gate'                        ELSE departure_gate END,
            arrival_gate           = CASE WHEN v_payload ? 'arrival_gate'           THEN v_payload->>'arrival_gate'                          ELSE arrival_gate END,
            flight_status          = CASE WHEN v_payload ? 'flight_status'          THEN coalesce(v_payload->>'flight_status', 'unknown')    ELSE coalesce(flight_status, 'unknown') END,
            flight_status_source      = v_payload->>'source',
            flight_status_observed_at = v_observed_at,
            updated_at                = now()
           WHERE id = v_segment_id
          RETURNING * INTO v_segment;
        EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'transport';
        v_event_type := 'trip.transport_segment_updated';
        v_result     := to_jsonb(v_segment) || jsonb_build_object('previous', v_applied);

$branches$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  -- family assignments, counted on an alignment-normalised COPY (2798's reason; d itself is EXECUTEd and keeps its spacing)
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  family_before := (length(dn) - length(replace(dn, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');

  -- 1. capability dispatch: engine (a crew traveller, or the system actor for a feed)
  n := (length(d) - length(replace(d, v_dispatch, ''))) / length(v_dispatch);
  IF n <> 1 THEN RAISE EXCEPTION '3826: anchor RECORD_OPPORTUNITY_CHANGE dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, v_dispatch, v_dispatch2);

  -- 2. ADD_TRANSPORT_SEGMENT refuses an estimate or a status (they have a source; ADD has none)
  n := (length(d) - length(replace(d, v_add_head, ''))) / length(v_add_head);
  IF n <> 1 THEN RAISE EXCEPTION '3826: anchor ADD_TRANSPORT_SEGMENT branch occurs % times, expected 1', n; END IF;
  d := replace(d, v_add_head, v_add_head2);

  -- 3. ADD_TRANSPORT_SEGMENT writes the itinerary columns: the column list ...
  n := (length(d) - length(replace(d, v_cols, ''))) / length(v_cols);
  IF n <> 1 THEN RAISE EXCEPTION '3826: anchor transport INSERT column list occurs % times, expected 1', n; END IF;
  d := replace(d, v_cols, v_cols2);

  -- 4. ... and the values
  n := (length(d) - length(replace(d, v_vals, ''))) / length(v_vals);
  IF n <> 1 THEN RAISE EXCEPTION '3826: anchor transport INSERT values occurs % times, expected 1', n; END IF;
  d := replace(d, v_vals, v_vals2);

  -- 5. the RECORD_FLIGHT_STATUS branch, immediately before UPDATE_TRANSPORT_SEGMENT's
  n := (length(d) - length(replace(d, v_upd_head, ''))) / length(v_upd_head);
  IF n <> 1 THEN RAISE EXCEPTION '3826: anchor UPDATE_TRANSPORT_SEGMENT branch occurs % times, expected 1', n; END IF;
  d := replace(d, v_upd_head, v_branch || v_upd_head);

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 1 THEN
    RAISE EXCEPTION '3826: expected exactly 1 new command branch, found % -> %', branches_before, branches_after;
  END IF;
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  family_after := (length(dn) - length(replace(dn, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');
  IF family_after <> family_before + 1 THEN
    RAISE EXCEPTION '3826: transport family assignments went from % to %, expected +1', family_before, family_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '3826: the definition did not grow'; END IF;

  EXECUTE d;
END
$mig$;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('trip_flight_segments_enabled', false,
   '3826 (Layover §3, census-layover L11): Trips flight segments. OFF / absent: POST/GET /trips/:tripId/flight-segments answer feature_disabled and read nothing. ON: a crew member adds a flight (carrier, number, airports, scheduled times, terminal, gate, booking ref) as a Trips transport segment through the kernel, and the trip''s flights are listed with explicit unknowns.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE d text; dn text; t text; n int; i int; j int; b text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trip_transport_segments'
         AND column_name IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                             'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal',
                             'arrival_terminal', 'departure_gate', 'arrival_gate', 'flight_status',
                             'flight_status_source', 'flight_status_observed_at')
         AND is_nullable = 'YES') <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3826): the 13 nullable flight columns are not all present';
  END IF;
  FOREACH t IN ARRAY ARRAY['trip_transport_carrier_code_format', 'trip_transport_flight_number_format',
                           'trip_transport_airports_iata', 'trip_transport_airports_distinct',
                           'trip_transport_terminals_gates_length', 'trip_transport_estimated_ordered',
                           'trip_transport_flight_status_known', 'trip_transport_flight_status_source_known',
                           'trip_transport_flight_status_provenance', 'trip_transport_flight_fields_only_on_flights'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trip_transport_segments'::regclass
                    AND conname = t AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3826): CHECK % missing or not validated', t;
    END IF;
  END LOOP;
  IF to_regclass('public.idx_trip_transport_segments_flight') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3826): idx_trip_transport_segments_flight missing';
  END IF;
  IF has_table_privilege('authenticated', 'public.trip_transport_segments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trip_transport_segments', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3826): authenticated can write trip_transport_segments';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  FOREACH t IN ARRAY ARRAY[
    $a$WHEN 'RECORD_FLIGHT_STATUS' THEN 'engine'$a$, $a$      WHEN 'RECORD_FLIGHT_STATUS' THEN$a$,
    'TRIP_FLIGHT_STATUS_STALE', 'flight_status_observed_at = v_observed_at',
    'departure_terminal, arrival_terminal, departure_gate, arrival_gate, flight_status)',
    'RECORD_FLIGHT_STATUS, with their source',
    -- what this transform did not name must still be there
    'ADD_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'TRIP_TRANSPORT_INVALID_TRANSITION', 'RECORD_OPPORTUNITY_CHANGE',
    'ADD_RECURRING_COMMITMENT', 'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3826): % missing after apply', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'      WHEN ''RECORD_FLIGHT_STATUS'' THEN\n', ''))) / length(E'      WHEN ''RECORD_FLIGHT_STATUS'' THEN\n');
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3826): % RECORD_FLIGHT_STATUS command branches, expected 1', n; END IF;
  -- The branch, cut from the INSTALLED definition: from its header to UPDATE_TRANSPORT_SEGMENT's.
  i := position(E'      WHEN ''RECORD_FLIGHT_STATUS'' THEN\n' in d);
  j := position($a$      WHEN 'UPDATE_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'REMOVE_TRANSPORT_SEGMENT' THEN$a$ in d);
  IF j <= i THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3826): the RECORD_FLIGHT_STATUS branch is not immediately before UPDATE_TRANSPORT_SEGMENT''s'; END IF;
  b := substr(d, i, j - i);
  n := (length(b) - length(replace(b, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3826): % other command branch(es) sit inside the RECORD_FLIGHT_STATUS branch', n; END IF;
  -- family assignments, measured on the branch: exactly one, transport, before its event
  b := regexp_replace(b, 'v_family\s+:=', 'v_family :=', 'g');
  n := (length(b) - length(replace(b, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3826): the RECORD_FLIGHT_STATUS branch files % family assignments under transport, expected 1', n; END IF;
  IF position(E'v_event_type := ''trip.transport_segment_updated'';' in b) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3826): the RECORD_FLIGHT_STATUS branch does not emit trip.transport_segment_updated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_flight_segments_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3826): trip_flight_segments_enabled is not seeded';
  END IF;
END
$post$;

COMMIT;
