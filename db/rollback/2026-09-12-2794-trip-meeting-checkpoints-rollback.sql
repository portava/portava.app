-- Rollback for 2794_trip_meeting_checkpoints.sql
--
-- Removes the meeting family (CREATE_MEETING_CHECKPOINT, SET_MEETING_ARRIVAL,
-- CLOSE_MEETING_CHECKPOINT) from trip_kernel_execute, drops the two checkpoint
-- tables, and drops safe_return_sessions.subgroup_id.
--
-- READ THIS BEFORE RUNNING IT. After this file:
--   * POST /trips/:tripId/regroup and the checkpoint routes are refused with
--     TRIP_COMMAND_UNKNOWN_TYPE by the kernel; the health projection's
--     REGROUP_OPEN reason has no source and is not derived; the map's meetup
--     layer is the plan-item label again; the offline bundle carries no
--     meeting points, as before 2794.
--   * Every checkpoint and its arrival states are DROPPED WITH THE TABLES. The
--     trip_events rows the family recorded survive — this file does not touch
--     trip_events.
--   * A Safe Return attached to a subgroup loses the attachment (the column
--     goes); the session itself survives, attached to its trip.
--
-- ORDER: any time after 2794. Nothing later depends on the family.
--
-- DATA: trip_meeting_checkpoints, trip_meeting_checkpoint_participants (all
-- rows), safe_return_sessions.subgroup_id (the values).
--
-- Rehearsed on scripts/local-db (apply 2794 → this file → 2794 again).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_meeting_checkpoints') IS NULL THEN
    RAISE EXCEPTION '2794 rollback: trip_meeting_checkpoints is not present — 2794 is not applied';
  END IF;
END
$pre$;

DO $rb$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2794: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('CREATE_MEETING_CHECKPOINT' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2794: the meeting family is not present here';
  END IF;

  -- 2. The three branches: from the first WHEN to REMOVE_PLAN's WHEN, which 2794 spliced them before.
  d := regexp_replace(d,
       $a$      WHEN 'CREATE_MEETING_CHECKPOINT' THEN.*?\n      WHEN 'REMOVE_PLAN' THEN$a$,
       $a$      WHEN 'REMOVE_PLAN' THEN$a$,
       '');

  -- 1. The dispatch line and the locals.
  d := replace(d, E'    WHEN ''CREATE_MEETING_CHECKPOINT'' THEN ''crew'' WHEN ''SET_MEETING_ARRIVAL'' THEN ''crew'' WHEN ''CLOSE_MEETING_CHECKPOINT'' THEN ''crew''\n', '');
  d := replace(d, E'  v_checkpoint_id uuid;\n', '');
  d := replace(d, E'  v_cp_lat     double precision;\n', '');
  d := replace(d, E'  v_cp_lng     double precision;\n', '');
  d := replace(d, E'  v_cp         record;\n', '');

  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 3 THEN
    RAISE EXCEPTION 'rollback 2794: the excision removed % arms, expected exactly 3', branches_before - n;
  END IF;
  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2794: the inverse transform did not shrink the definition';
  END IF;

  EXECUTE d;
END
$rb$;

DROP TABLE public.trip_meeting_checkpoint_participants;
DROP TABLE public.trip_meeting_checkpoints;
ALTER TABLE public.safe_return_sessions
  DROP CONSTRAINT IF EXISTS safe_return_sessions_subgroup_needs_trip,
  DROP COLUMN subgroup_id;

DO $post$
DECLARE d text; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  FOREACH t IN ARRAY ARRAY['CREATE_MEETING_CHECKPOINT', 'SET_MEETING_ARRIVAL', 'CLOSE_MEETING_CHECKPOINT',
                           'trip.meeting_checkpoint_created', 'trip.meeting_arrival_set', 'trip.meeting_checkpoint_closed',
                           'v_family     := ''meeting'';', 'v_checkpoint_id', 'v_cp_lat', 'v_cp_lng', 'v_cp '] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2794: % survived', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['CREATE_SUBGROUP', 'DISSOLVE_SUBGROUP', 'REMOVE_PLAN', 'TRIP_VERSION_CONFLICT', 'trip_command_receipts', 'RECORD_OPPORTUNITY_CHANGE'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2794: % lost', t; END IF;
  END LOOP;
  IF to_regclass('public.trip_meeting_checkpoints') IS NOT NULL THEN RAISE EXCEPTION 'rollback 2794: trip_meeting_checkpoints survived'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.safe_return_sessions'::regclass AND attname = 'subgroup_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback 2794: safe_return_sessions.subgroup_id survived';
  END IF;
END
$post$;

COMMIT;
