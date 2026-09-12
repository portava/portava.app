-- Rollback for 2786_trip_kernel_opportunity_events.sql
--
-- Removes RECORD_OPPORTUNITY_CHANGE and its engine-capability dispatch line.
-- The 'engine' capability itself is 2785's and stays.
--
-- READ THIS BEFORE RUNNING IT. After this file:
--   * services/trips/TripOpportunityProjection.ts's RECORD_OPPORTUNITY_CHANGE
--     is refused with TRIP_COMMAND_UNKNOWN_TYPE; the projection reports it as
--     `recorded.failed` and keeps serving. Events already recorded as
--     trip.opportunities_changed survive in trip_events — this file does not
--     touch data.
--
-- ORDER: any time after 2786, before 2785's rollback if one is ever written
-- (this file's capability anchor is 2785's).
--
-- DATA: none.
--
-- Rehearsed on scripts/local-db (apply 2786 → this file → 2786 again).

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2786: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('RECORD_OPPORTUNITY_CHANGE' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2786: not applied here';
  END IF;

  -- 2. The branch: from its WHEN to the next branch's WHEN, whichever family that is.
  d := regexp_replace(d,
       $a$      WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN.*?\n      WHEN '$a$,
       $a$      WHEN '$a$,
       '');

  -- 1. The dispatch line and the local.
  d := replace(d, E'    WHEN ''RECORD_OPPORTUNITY_CHANGE'' THEN ''engine''\n', '');
  d := replace(d, E'  v_opp_significance text;\n', '');

  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 1 THEN
    RAISE EXCEPTION 'rollback 2786: the excision removed % arms, expected exactly 1', branches_before - n;
  END IF;
  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2786: the inverse transform did not shrink the definition';
  END IF;

  EXECUTE d;
END
$rb$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  FOREACH t IN ARRAY ARRAY['RECORD_OPPORTUNITY_CHANGE', 'trip.opportunities_changed', 'v_family     := ''opportunity'';', 'v_opp_significance',
                           'significance must be none | low | medium | high | critical'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2786: % survived', t; END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['DECLARE_DISRUPTION', 'RESOLVE_DISRUPTION', 'MARK_COMMITMENT_AT_RISK', 'OPEN_FREE_WINDOW',
                           'WHEN ''engine'' THEN', 'START_PLAN', 'CREATE_SUBGROUP', 'ADD_TRANSPORT_SEGMENT',
                           'CREATE_PROPOSAL', 'CREATE_TRIP', 'TRIP_VERSION_CONFLICT', 'trip_command_receipts', 'trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2786: % lost — the excision overran', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'THEN ''engine''', ''))) / length('THEN ''engine''');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2786: expected 2785''s 3 engine-capability commands to remain, found %', n; END IF;
END
$post$;

COMMIT;
