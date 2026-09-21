-- Rollback for 2798_trip_kernel_recurrence_family.sql
--
-- Removes the five recurrence commands from trip_kernel_execute, returning the
-- function to its pre-2798 shape.
--
-- The INVERSE TRANSFORM, for the reason the 2764 and 2765 rollbacks give:
-- re-CREATEing the body would silently discard any later migration that had
-- touched the function, and reversing three named edits cannot.
--
-- DATA: none. trip_commitment_recurrences rows are untouched — this removes the
-- WRITER, not the table. Withdrawing the table is
-- db/rollback/2026-09-17-2797-trip-commitment-recurrences-rollback.sql, and it
-- must run AFTER this one (it refuses otherwise).
--
-- This file must run BEFORE the 2765 rollback: the excision below is anchored
-- on the ADD_COMMITMENT branch, and a kernel with no commitment family has
-- nothing for it to anchor to.
--
-- Rehearsed on db/harness/run.sh, which fails unless the restored definition is
-- byte-identical to the one captured before 2798 and unless a second run of
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
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2798: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('ADD_RECURRING_COMMITMENT' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2798: the recurrence family is not present; 2798 was never applied here';
  END IF;
  IF position('ADD_COMMITMENT'' THEN' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2798: the commitment family is gone, so the excision has no terminator. The 2765 rollback was run first; that ordering is wrong.';
  END IF;

  -- 1. The five branches, reversed first, so a failure here leaves the
  -- declarations and dispatch intact rather than routing to nothing.
  d := regexp_replace(
         d,
         $a$      WHEN 'ADD_RECURRING_COMMITMENT' THEN.*?      WHEN 'ADD_COMMITMENT' THEN$a$,
         $a$      WHEN 'ADD_COMMITMENT' THEN$a$,
         -- No 'n' flag: in Postgres ARE, 'n' makes '.' STOP matching newline,
         -- the opposite of what a multi-line excision needs. Non-greedy '.*?'
         -- then stops at the FIRST ADD_COMMITMENT branch, which is the one 2798
         -- re-appended.
         '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 5 THEN
    RAISE EXCEPTION 'rollback 2798: the excision removed % command branches, expected exactly 5', branches_before - n;
  END IF;

  -- 2. The capability dispatch — two lines, removed as one block.
  n := (length(d) - length(replace(d, $a$    WHEN 'ADD_RECURRING_COMMITMENT' THEN 'crew'$a$, ''))) / length($a$    WHEN 'ADD_RECURRING_COMMITMENT' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2798: dispatch anchor occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_RECURRING_COMMITMENT' THEN 'crew' WHEN 'UPDATE_RECURRING_COMMITMENT' THEN 'crew' WHEN 'REMOVE_RECURRING_COMMITMENT' THEN 'crew'
    WHEN 'SKIP_RECURRENCE_OCCURRENCE' THEN 'crew' WHEN 'UNSKIP_RECURRENCE_OCCURRENCE' THEN 'crew'
    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$,
                  $a$    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$);
  IF position($a$WHEN 'ADD_RECURRING_COMMITMENT' THEN 'crew'$a$ in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2798: the dispatch block was not removed';
  END IF;

  -- 3. The declarations.
  d := replace(d, '  v_commit_id  uuid;' || E'\n' ||
                  '  v_rec_id     uuid;' || E'\n' ||
                  '  v_rec_tz     text;' || E'\n' ||
                  '  v_rec_from   date;' || E'\n' ||
                  '  v_rec_until  date;' || E'\n' ||
                  '  v_rec_day    date;',
                  '  v_commit_id  uuid;');
  IF position('  v_rec_id     uuid;' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2798: the declarations were not removed';
  END IF;

  IF position('ADD_RECURRING_COMMITMENT' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2798: something named ADD_RECURRING_COMMITMENT survived the excision';
  END IF;
  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2798: the definition did not shrink';
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

  FOREACH t IN ARRAY ARRAY['ADD_RECURRING_COMMITMENT','UPDATE_RECURRING_COMMITMENT','REMOVE_RECURRING_COMMITMENT',
                           'SKIP_RECURRENCE_OCCURRENCE','UNSKIP_RECURRENCE_OCCURRENCE',
                           'trip.recurring_commitment_added','trip.recurrence_occurrence_skipped',
                           'TRIP_RECURRENCE_NOT_FOUND','TRIP_RECURRENCE_TIMEZONE_UNKNOWN',
                           'TRIP_RECURRENCE_RANGE_TOO_LONG','TRIP_RECURRENCE_DATE_OUT_OF_RANGE',
                           'v_rec_id','v_rec_tz','v_rec_from','v_rec_until','v_rec_day'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2798: % survived', t; END IF;
  END LOOP;

  -- The pre-2798 kernel must be INTACT, not merely recurrence-free. An excision
  -- that overran would satisfy every check above and none of these.
  FOREACH t IN ARRAY ARRAY['ADD_COMMITMENT','UPDATE_COMMITMENT','REMOVE_COMMITMENT','ADD_LEG','ADD_STAGE',
                           'SET_TRIP_COVER','REMOVE_PLAN','JOIN_VIA_LINK','CREATE_TRIP',
                           'TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2798: % lost — the excision overran', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2798: 2764''s 3 stage-family assignments became % — the excision overran', n; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2798: expected the 2 trip-level range checks, found %', n; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''commitment'';', ''))) / length(E'v_family     := ''commitment'';');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2798: 2765''s 3 commitment-family assignments became %', n; END IF;
  n := (length(d) - length(replace(d, '  v_commit_id  uuid;', ''))) / length('  v_commit_id  uuid;');
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2798: the v_commit_id declaration is not intact (found %)', n; END IF;
END
$post$;

COMMIT;
