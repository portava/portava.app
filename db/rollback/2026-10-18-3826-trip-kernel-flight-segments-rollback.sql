-- Rollback for 3826_trip_kernel_flight_segments.sql (census-layover L11, L267; Layover 165 program, lane B1-F).
-- Dated the day it was written, the db/rollback/ convention.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3826 DID (one transaction, additive):
--   * added thirteen nullable flight columns to trip_transport_segments (carrier_code, flight_number,
--     departure_airport_iata, arrival_airport_iata, estimated_departure_at, estimated_arrival_at, departure_terminal,
--     arrival_terminal, departure_gate, arrival_gate, flight_status, flight_status_source, flight_status_observed_at),
--     ten CHECKs (trip_transport_carrier_code_format ... trip_transport_flight_fields_only_on_flights), three column
--     comments and the index idx_trip_transport_segments_flight;
--   * transformed public.trip_kernel_execute (2764's method) in five named places: the RECORD_FLIGHT_STATUS dispatch
--     entry ('engine'), a refusal at the head of ADD_TRANSPORT_SEGMENT, the INSERT's column list and values, and the
--     RECORD_FLIGHT_STATUS branch immediately before UPDATE_TRANSPORT_SEGMENT's;
--   * seeded trip_flight_segments_enabled FALSE (ON CONFLICT DO NOTHING).
--
-- WHAT THIS DOES: the INVERSE TRANSFORM — each of the five edits replaced by the exact text it replaced (the literals
-- below are 3826's, byte for byte), so the kernel is the one before 3826 to the byte and anything a later migration
-- added elsewhere survives (re-creating the body would discard it: the 2764/2798 rollbacks' reason); then drops the
-- index, the ten CHECKs and the thirteen columns, deletes the flag row and 3826's ledger row, and asks PostgREST to
-- reload its schema cache.
--
-- DATA.
-- IT REFUSES WHILE 3827 IS INSTALLED (layover_sessions.arrival_segment_id exists): 3827 links layover sessions to these
-- flight segments and its code reads these columns. Roll 3827 back first.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG (0118's ON DELETE CASCADE would erase it).
-- IT REFUSES WHILE ANY trip_transport_segments ROW CARRIES A FLIGHT FACT: any of the twelve columns other than
-- flight_status set, or a flight_status other than the 'unknown' ADD_TRANSPORT_SEGMENT stamps on every flight. Those
-- are a traveller's itinerary (carrier, number, airports, terminals, gates) or an observation with its source;
-- dropping them is the owner's decision. It DROPS, by design, the bare 'unknown' stamp: it says only that nothing was
-- observed, and is reported in a NOTICE.
-- NOT TOUCHED: trip_events and trip_command_receipts rows that RECORD_FLIGHT_STATUS wrote. They are the trip's
-- immutable history (type trip.transport_segment_updated, command_type RECORD_FLIGHT_STATUS); after this rollback a
-- replay of such a command's idempotency key still answers its stored receipt, and a NEW one is refused as
-- TRIP_COMMAND_UNKNOWN_TYPE.
--
-- Refuses, changing nothing, unless the installed state is exactly 3826's: the flag TRUE (turn it off deliberately
-- first) or missing while 3826's objects stand; each of 3826's columns, CHECKs, comments and its index not present
-- exactly once or not as 3826 defines them (md5 of this server's deparse, measured on PostgreSQL 18.3 — PGlite 0.5.8 over
-- the production packet's replica; a different deparse refuses rather than drops); each of the five kernel edits not
-- present exactly once; an object 3826 did not make depending on a column. With none of 3826's objects it changes
-- nothing and clears only the (already absent) ledger row, so a second run is a no-op.
--
-- LOCK (held until the COMMIT): ACCESS EXCLUSIVE on public.trip_transport_segments (DROP COLUMN); the kernel's
-- CREATE OR REPLACE FUNCTION takes its function lock, and a trip command running at that moment completes first. Every
-- check runs first under ACCESS SHARE; lock_timeout = 5s. On a timeout nothing has changed and the file can be re-run.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_flags   int;
  v_on      boolean;
  v_present int;
  v_audit   bigint;
  v_n       bigint;
  v_bad     text;
  v_dep     text;
  d         text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.trip_transport_segments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3826 rollback): public.feature_flags, public.schema_migration_ledger and public.trip_transport_segments must exist.';
  END IF;
  IF to_regclass('public.layover_sessions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass AND attname = 'arrival_segment_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): 3827 is installed (layover_sessions.arrival_segment_id exists). It links layover sessions to these flight segments; roll 3827 back first (db/rollback/2026-10-18-3827-layover-sessions-flight-connection-rollback.sql). Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.feature_flags WHERE flag = 'trip_flight_segments_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'trip_flight_segments_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): trip_flight_segments_enabled is TRUE. The owner has turned Trips flight segments on since 3826 was applied; deleting the row would silently turn them off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.trip_transport_segments'::regclass AND NOT attisdropped
            AND attname IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                            'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal',
                            'departure_gate', 'arrival_gate', 'flight_status', 'flight_status_source', 'flight_status_observed_at'))
       + (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.trip_transport_segments'::regclass
            AND conname IN ('trip_transport_carrier_code_format', 'trip_transport_flight_number_format', 'trip_transport_airports_iata',
                            'trip_transport_airports_distinct', 'trip_transport_terminals_gates_length', 'trip_transport_estimated_ordered',
                            'trip_transport_flight_status_known', 'trip_transport_flight_status_source_known',
                            'trip_transport_flight_status_provenance', 'trip_transport_flight_fields_only_on_flights'))
       + (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'idx_trip_transport_segments_flight')
       + (CASE WHEN position('RECORD_FLIGHT_STATUS' in coalesce(d, '')) > 0 THEN 1 ELSE 0 END)
    INTO v_present;
  IF v_present = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3826 rollback: none of 3826''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_present <> 25 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): 3826''s objects are not each present exactly once (% of 25: thirteen columns, ten CHECKs, one index, the kernel''s RECORD_FLIGHT_STATUS; % of 1 flag row). 3826 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_present, v_flags;
  END IF;

  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag IN ('trip_flight_segments_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3826): public.feature_flag_audit_log holds % row(s) recording who turned trip_flight_segments_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.trip_transport_segments
              WHERE carrier_code IS NOT NULL OR flight_number IS NOT NULL OR departure_airport_iata IS NOT NULL
                 OR arrival_airport_iata IS NOT NULL OR estimated_departure_at IS NOT NULL OR estimated_arrival_at IS NOT NULL
                 OR departure_terminal IS NOT NULL OR arrival_terminal IS NOT NULL OR departure_gate IS NOT NULL
                 OR arrival_gate IS NOT NULL OR flight_status_source IS NOT NULL OR flight_status_observed_at IS NOT NULL
                 OR flight_status IS DISTINCT FROM CASE WHEN mode = 'flight' AND flight_status IS NOT NULL THEN 'unknown' END$q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): % trip_transport_segments row(s) carry a flight fact (an itinerary field, an estimate, a terminal or gate, or an observed status with its source). Dropping the columns erases a traveller''s flights; that is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_n;
  END IF;

  -- 3826's table objects, exactly, as this server deparses them.
  WITH expected(k, v) AS (VALUES
    ('con:trip_transport_airports_distinct', '744a6b2c59d9a4c3040b9aa7df8c002f'),
    ('con:trip_transport_airports_iata', '7dcfc1a6aa06c002871443f41e851dd4'),
    ('con:trip_transport_carrier_code_format', '52775a2386951d9f6d2acc6137ee0845'),
    ('con:trip_transport_estimated_ordered', '79a2afc02615aae0ffb7983265c9f124'),
    ('con:trip_transport_flight_fields_only_on_flights', 'ae1fce8ecb02a5cfc73a4527926263e4'),
    ('con:trip_transport_flight_number_format', '4d391b2ae7b40bb0b89b134f89e75a30'),
    ('con:trip_transport_flight_status_known', 'eb6a091ab7698449d3990335669f3d0f'),
    ('con:trip_transport_flight_status_provenance', '5a85859821d932ffeaf63cfdcbafd79b'),
    ('con:trip_transport_flight_status_source_known', 'f9e9b92167d1e84db6a53b925470b3a8'),
    ('con:trip_transport_terminals_gates_length', 'd201ca1361ff219e96ea08be00836a6f'),
    ('idx:idx_trip_transport_segments_flight', '750f59a776538f610bfadbf40fe4cba7'),
    ('comment:carrier_code', '520f2e9c141b5c2b2e8950bb8cb51230'),
    ('comment:estimated_departure_at', 'a8b0587c3f179fe05d62d674823cb560'),
    ('comment:flight_status', '3234b369d2f55ef879f3de1bd3cbb5c6')
  ), cols AS (
    SELECT a.attnum, a.attname FROM pg_attribute a
     WHERE a.attrelid = 'public.trip_transport_segments'::regclass AND NOT a.attisdropped
       AND a.attname IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                         'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal',
                         'departure_gate', 'arrival_gate', 'flight_status', 'flight_status_source', 'flight_status_observed_at')
  ), actual(k, v) AS (
    -- every constraint that names a 3826 column, or carries a 3826 name
    SELECT 'con:' || k.conname, md5(pg_get_constraintdef(k.oid))
      FROM pg_constraint k
     WHERE k.conrelid = 'public.trip_transport_segments'::regclass AND k.contype <> 'n'
       AND (k.conname LIKE 'trip\_transport\_%' AND k.conname IN ('trip_transport_carrier_code_format', 'trip_transport_flight_number_format',
              'trip_transport_airports_iata', 'trip_transport_airports_distinct', 'trip_transport_terminals_gates_length',
              'trip_transport_estimated_ordered', 'trip_transport_flight_status_known', 'trip_transport_flight_status_source_known',
              'trip_transport_flight_status_provenance', 'trip_transport_flight_fields_only_on_flights')
            OR k.conkey && (SELECT array_agg(attnum) FROM cols))
    UNION ALL
    -- every index that involves a 3826 column, or carries 3826's name
    SELECT 'idx:' || ic.relname, md5(pg_get_indexdef(i.indexrelid))
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = 'public.trip_transport_segments'::regclass
       AND (ic.relname = 'idx_trip_transport_segments_flight'
            OR EXISTS (SELECT 1 FROM cols WHERE cols.attnum = ANY (i.indkey::int2[]))
            OR EXISTS (SELECT 1 FROM cols WHERE position(cols.attname IN coalesce(pg_get_expr(i.indexprs, i.indrelid), '')
                                                          || coalesce(pg_get_expr(i.indpred, i.indrelid), '')) > 0))
    UNION ALL
    SELECT 'comment:' || c.attname, md5(col_description('public.trip_transport_segments'::regclass, c.attnum))
      FROM cols c WHERE col_description('public.trip_transport_segments'::regclass, c.attnum) IS NOT NULL
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): the installed objects are not 3826''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.trip_transport_segments'::regclass AND NOT a.attisdropped
        AND a.attnotnull AND a.attname IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
            'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal', 'departure_gate',
            'arrival_gate', 'flight_status', 'flight_status_source', 'flight_status_observed_at')) <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): a 3826 column was made NOT NULL by hand. Nothing was changed.';
  END IF;

  -- Nothing 3826 did not make may depend on its columns.
  WITH cols AS (
    SELECT attnum FROM pg_attribute WHERE attrelid = 'public.trip_transport_segments'::regclass AND NOT attisdropped
       AND attname IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                       'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal',
                       'departure_gate', 'arrival_gate', 'flight_status', 'flight_status_source', 'flight_status_observed_at')
  ), mine AS (
    SELECT 'pg_constraint'::regclass::oid AS classid, k.oid AS objid FROM pg_constraint k
     WHERE k.conrelid = 'public.trip_transport_segments'::regclass
       AND k.conname IN ('trip_transport_carrier_code_format', 'trip_transport_flight_number_format', 'trip_transport_airports_iata',
                         'trip_transport_airports_distinct', 'trip_transport_terminals_gates_length', 'trip_transport_estimated_ordered',
                         'trip_transport_flight_status_known', 'trip_transport_flight_status_source_known',
                         'trip_transport_flight_status_provenance', 'trip_transport_flight_fields_only_on_flights')
    UNION ALL
    SELECT 'pg_class'::regclass::oid, c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'idx_trip_transport_segments_flight'
  )
  SELECT string_agg(DISTINCT pg_describe_object(dd.classid, dd.objid, dd.objsubid), '; ') INTO v_dep
    FROM pg_depend dd
   WHERE dd.deptype IN ('n', 'a')
     AND dd.refclassid = 'pg_class'::regclass AND dd.refobjid = 'public.trip_transport_segments'::regclass
     AND dd.refobjsubid IN (SELECT attnum FROM cols)
     AND (dd.classid, dd.objid) NOT IN (SELECT classid, objid FROM mine);
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): objects 3826 did not make depend on its columns: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'trip_flight_segments_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3826_trip_kernel_flight_segments.sql';
NOTIFY pgrst, 'reload schema';

-- ── the inverse transform ───────────────────────────────────────────────────
DO $rb$
DECLARE
  d text;
  dn text;
  n int;
  before_len int;
  branches_before int;
  family_before int;
  family_after int;
  -- 3826's literals, verbatim (copied from the migration's $mig$ block).
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
  IF d IS NULL OR position('RECORD_FLIGHT_STATUS' in d) = 0 THEN
    RETURN;  -- nothing of 3826's in the kernel (the $pre$ above returned already, or this is a second run)
  END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  family_before := (length(dn) - length(replace(dn, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');

  -- 5. the branch first, so a failure below leaves the dispatch routing to an intact kernel
  n := (length(d) - length(replace(d, v_branch || v_upd_head, ''))) / length(v_branch || v_upd_head);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 3826: the RECORD_FLIGHT_STATUS branch, as 3826 wrote it, occurs % times, expected 1', n; END IF;
  d := replace(d, v_branch || v_upd_head, v_upd_head);
  -- 4. the INSERT values
  n := (length(d) - length(replace(d, v_vals2, ''))) / length(v_vals2);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 3826: the INSERT values anchor occurs % times, expected 1', n; END IF;
  d := replace(d, v_vals2, v_vals);
  -- 3. the INSERT column list
  n := (length(d) - length(replace(d, v_cols2, ''))) / length(v_cols2);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 3826: the INSERT column-list anchor occurs % times, expected 1', n; END IF;
  d := replace(d, v_cols2, v_cols);
  -- 2. the ADD refusal
  n := (length(d) - length(replace(d, v_add_head2, ''))) / length(v_add_head2);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 3826: the ADD_TRANSPORT_SEGMENT refusal occurs % times, expected 1', n; END IF;
  d := replace(d, v_add_head2, v_add_head);
  -- 1. the dispatch entry
  n := (length(d) - length(replace(d, v_dispatch2, ''))) / length(v_dispatch2);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 3826: dispatch anchor occurs % times, expected 1', n; END IF;
  d := replace(d, v_dispatch2, v_dispatch);

  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 1 THEN
    RAISE EXCEPTION 'rollback 3826: the excision removed % command branches, expected exactly 1 — the excision overran or fell short', branches_before - n;
  END IF;
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  family_after := (length(dn) - length(replace(dn, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');
  IF family_after <> family_before - 1 THEN
    RAISE EXCEPTION 'rollback 3826: transport family assignments went from % to %, expected -1 — the excision overran', family_before, family_after;
  END IF;
  IF position('RECORD_FLIGHT_STATUS' in d) > 0 OR position('TRIP_FLIGHT_STATUS_STALE' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 3826: something of RECORD_FLIGHT_STATUS survived the excision';
  END IF;
  IF length(d) >= before_len THEN RAISE EXCEPTION 'rollback 3826: the definition did not shrink'; END IF;
  EXECUTE d;
END
$rb$;

DO $rbt$
DECLARE
  v_n       bigint;
  v_stamped bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trip_transport_segments'::regclass
                  AND attname = 'carrier_code' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  LOCK TABLE public.trip_transport_segments IN ACCESS EXCLUSIVE MODE;
  EXECUTE $q$SELECT count(*) FROM public.trip_transport_segments
              WHERE carrier_code IS NOT NULL OR flight_number IS NOT NULL OR departure_airport_iata IS NOT NULL
                 OR arrival_airport_iata IS NOT NULL OR estimated_departure_at IS NOT NULL OR estimated_arrival_at IS NOT NULL
                 OR departure_terminal IS NOT NULL OR arrival_terminal IS NOT NULL OR departure_gate IS NOT NULL
                 OR arrival_gate IS NOT NULL OR flight_status_source IS NOT NULL OR flight_status_observed_at IS NOT NULL
                 OR flight_status IS DISTINCT FROM CASE WHEN mode = 'flight' AND flight_status IS NOT NULL THEN 'unknown' END$q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3826): a flight fact was written while this file ran; nothing is dropped. Nothing was changed.';
  END IF;
  EXECUTE 'SELECT count(*) FROM public.trip_transport_segments WHERE flight_status IS NOT NULL' INTO v_stamped;
  RAISE NOTICE '3826 rollback: dropping the bare ''unknown'' flight_status stamp of % flight segment(s).', v_stamped;
  DROP INDEX public.idx_trip_transport_segments_flight;
  ALTER TABLE public.trip_transport_segments
    DROP CONSTRAINT trip_transport_flight_fields_only_on_flights,
    DROP CONSTRAINT trip_transport_flight_status_provenance,
    DROP CONSTRAINT trip_transport_flight_status_source_known,
    DROP CONSTRAINT trip_transport_flight_status_known,
    DROP CONSTRAINT trip_transport_estimated_ordered,
    DROP CONSTRAINT trip_transport_terminals_gates_length,
    DROP CONSTRAINT trip_transport_airports_distinct,
    DROP CONSTRAINT trip_transport_airports_iata,
    DROP CONSTRAINT trip_transport_flight_number_format,
    DROP CONSTRAINT trip_transport_carrier_code_format,
    DROP COLUMN flight_status_observed_at,
    DROP COLUMN flight_status_source,
    DROP COLUMN flight_status,
    DROP COLUMN arrival_gate,
    DROP COLUMN departure_gate,
    DROP COLUMN arrival_terminal,
    DROP COLUMN departure_terminal,
    DROP COLUMN estimated_arrival_at,
    DROP COLUMN estimated_departure_at,
    DROP COLUMN arrival_airport_iata,
    DROP COLUMN departure_airport_iata,
    DROP COLUMN flight_number,
    DROP COLUMN carrier_code;
END $rbt$;

COMMIT;

DO $post$
DECLARE d text; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  FOREACH t IN ARRAY ARRAY['RECORD_FLIGHT_STATUS', 'TRIP_FLIGHT_STATUS_STALE', 'flight_status_observed_at', 'carrier_code'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): % survived in the kernel', t; END IF;
  END LOOP;
  -- The pre-3826 kernel must be INTACT, not merely flight-free.
  FOREACH t IN ARRAY ARRAY['ADD_TRANSPORT_SEGMENT', 'UPDATE_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'REMOVE_TRANSPORT_SEGMENT',
                           'RECORD_OPPORTUNITY_CHANGE', 'TRIP_TRANSPORT_INVALID_TRANSITION', 'ADD_RECURRING_COMMITMENT',
                           'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox',
                           'booking_ref, fallback_of, created_by)'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): % lost — the excision overran', t; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trip_transport_segments'::regclass AND NOT attisdropped
              AND attname IN ('carrier_code', 'flight_number', 'departure_airport_iata', 'arrival_airport_iata',
                              'estimated_departure_at', 'estimated_arrival_at', 'departure_terminal', 'arrival_terminal',
                              'departure_gate', 'arrival_gate', 'flight_status', 'flight_status_source', 'flight_status_observed_at')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): a flight column still exists on trip_transport_segments.';
  END IF;
  IF to_regclass('public.idx_trip_transport_segments_flight') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): idx_trip_transport_segments_flight survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_flight_segments_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): trip_flight_segments_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3826_trip_kernel_flight_segments.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3826): the ledger still records 3826 as applied.';
  END IF;
END $post$;
