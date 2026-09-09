-- Rollback for 2765_trip_kernel_leg_and_commitment_families.sql
--
-- Removes the six leg and commitment commands from trip_kernel_execute,
-- returning the function to its post-2764 shape.
--
-- The INVERSE TRANSFORM, for the reason the 2764 rollback gives: re-CREATEing
-- the body would silently discard any later migration that had touched the
-- function, and reversing three named edits cannot.
--
-- DATA: none. trip_legs and trip_commitments rows are untouched — this removes
-- the writer, not the tables. Withdrawing those is
-- db/rollback/2026-09-09-2761-trip-legs-and-commitments-rollback.sql, and it
-- must run AFTER this one. This file must in turn run BEFORE the 2764 rollback:
-- the excision below is anchored on the ADD_STAGE branch, and a kernel with no
-- stage family has nothing for it to anchor to.
--
-- Rehearsed on db/harness/run.sh, which fails unless the restored definition is
-- byte-identical to the one captured before 2765 and unless a second run of
-- this file refuses.

BEGIN;

DO $rb$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2765: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('ADD_LEG' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2765: the leg family is not present; 2765 was never applied here';
  END IF;
  IF position('ADD_STAGE' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2765: the stage family is gone, so the excision has no terminator. The 2764 rollback was run first; that ordering is wrong.';
  END IF;

  -- 3. The six branches, reversed first, so a failure here leaves the
  -- declarations and dispatch intact rather than routing to nothing.
  d := regexp_replace(
         d,
         $a$      WHEN 'ADD_LEG' THEN.*?      WHEN 'ADD_STAGE' THEN$a$,
         $a$      WHEN 'ADD_STAGE' THEN$a$,
         -- No 'n' flag: in Postgres ARE, 'n' makes '.' STOP matching newline,
         -- the opposite of what a multi-line excision needs. Non-greedy '.*?'
         -- then stops at the FIRST ADD_STAGE, which is the one 2765 re-appended.
         '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 6 THEN
    RAISE EXCEPTION 'rollback 2765: the excision removed % command branches, expected exactly 6', branches_before - n;
  END IF;

  -- 2. The capability dispatch — two lines, removed as one block.
  n := (length(d) - length(replace(d, $a$WHEN 'REMOVE_COMMITMENT' THEN 'crew'$a$, ''))) / length($a$WHEN 'REMOVE_COMMITMENT' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2765: the dispatch block occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_LEG' THEN 'crew' WHEN 'UPDATE_LEG' THEN 'crew' WHEN 'REMOVE_LEG' THEN 'crew'
    WHEN 'ADD_COMMITMENT' THEN 'crew' WHEN 'UPDATE_COMMITMENT' THEN 'crew' WHEN 'REMOVE_COMMITMENT' THEN 'crew'
$a$, '');

  -- 1. The declarations.
  n := (length(d) - length(replace(d, '  v_leg_id     uuid;', ''))) / length('  v_leg_id     uuid;');
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2765: the v_leg_id declaration occurs % times, expected 1', n; END IF;
  d := replace(d, E'  v_leg_id     uuid;\n', '');
  n := (length(d) - length(replace(d, '  v_commit_id  uuid;', ''))) / length('  v_commit_id  uuid;');
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2765: the v_commit_id declaration occurs % times, expected 1', n; END IF;
  d := replace(d, E'  v_commit_id  uuid;\n', '');

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2765: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['ADD_LEG','UPDATE_LEG','REMOVE_LEG','ADD_COMMITMENT',
                           'UPDATE_COMMITMENT','REMOVE_COMMITMENT','v_leg_id','v_commit_id',
                           'trip.leg_','trip.commitment_','TRIP_LEG_NOT_FOUND',
                           'TRIP_COMMITMENT_NOT_FOUND'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2765: % survived', t; END IF;
  END LOOP;

  -- The post-2764 kernel must be INTACT, not merely leg-free. An excision that
  -- overran would satisfy every check above and none of these.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','UPDATE_STAGE','REMOVE_STAGE','SET_TRIP_COVER',
                           'REMOVE_PLAN','JOIN_VIA_LINK','CREATE_TRIP',
                           'TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2765: % lost — the excision overran', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2765: 2764''s 3 stage-family assignments became %', n; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2765: expected the 2 trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
