-- Rollback for 2766_trip_kernel_goal_decision_risk_families.sql
--
-- Removes the nine goal, decision-task and risk commands from
-- trip_kernel_execute, returning the function to its post-2765 shape.
--
-- The INVERSE TRANSFORM, for the reason the 2764 and 2765 rollbacks give.
--
-- ORDER: this file must run BEFORE the 2765 rollback and therefore before the
-- 2764 one. Its excision is anchored on the ADD_LEG branch; a kernel with no
-- leg family has nothing for it to anchor to, and it says so rather than
-- guessing.
--
-- DATA: none. trip_goals, trip_decision_tasks and trip_risks rows are
-- untouched — this removes the writer, not the tables. Withdrawing those is
-- db/rollback/2026-09-09-2762-trip-goals-decisions-risks-rollback.sql.
--
-- Rehearsed on db/harness/run.sh, which fails unless the restored definition is
-- byte-identical to the one captured before 2766 and unless a second run of
-- this file refuses.

BEGIN;

DO $rb$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
  t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2766: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('ADD_GOAL' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2766: the goal family is not present; 2766 was never applied here';
  END IF;
  IF position('ADD_LEG' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2766: the leg family is gone, so the excision has no terminator. The 2765 rollback was run first; that ordering is wrong.';
  END IF;

  -- 3. The nine branches, reversed first.
  d := regexp_replace(
         d,
         $a$      WHEN 'ADD_GOAL' THEN.*?      WHEN 'ADD_LEG' THEN$a$,
         $a$      WHEN 'ADD_LEG' THEN$a$,
         -- No 'n' flag: in Postgres ARE, 'n' makes '.' STOP matching newline,
         -- the opposite of what a multi-line excision needs.
         '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 9 THEN
    RAISE EXCEPTION 'rollback 2766: the excision removed % command branches, expected exactly 9', branches_before - n;
  END IF;

  -- 2. The capability dispatch — three lines, removed as one block.
  n := (length(d) - length(replace(d, $a$WHEN 'REMOVE_RISK' THEN 'crew'$a$, ''))) / length($a$WHEN 'REMOVE_RISK' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2766: the dispatch block occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_GOAL' THEN 'crew' WHEN 'UPDATE_GOAL' THEN 'crew' WHEN 'REMOVE_GOAL' THEN 'crew'
    WHEN 'ADD_DECISION_TASK' THEN 'crew' WHEN 'UPDATE_DECISION_TASK' THEN 'crew' WHEN 'REMOVE_DECISION_TASK' THEN 'crew'
    WHEN 'ADD_RISK' THEN 'crew' WHEN 'UPDATE_RISK' THEN 'crew' WHEN 'REMOVE_RISK' THEN 'crew'
$a$, '');

  -- 1. The three declarations.
  FOREACH t IN ARRAY ARRAY['  v_goal_id    uuid;', '  v_task_id    uuid;', '  v_risk_id    uuid;'] LOOP
    n := (length(d) - length(replace(d, t, ''))) / length(t);
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2766: the declaration % occurs % times, expected 1', t, n; END IF;
    d := replace(d, t || E'\n', '');
  END LOOP;

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2766: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['ADD_GOAL','UPDATE_GOAL','REMOVE_GOAL',
                           'ADD_DECISION_TASK','UPDATE_DECISION_TASK','REMOVE_DECISION_TASK',
                           'ADD_RISK','UPDATE_RISK','REMOVE_RISK',
                           'v_goal_id','v_task_id','v_risk_id',
                           'trip.goal_','trip.decision_task_','trip.risk_',
                           'TRIP_GOAL_NOT_FOUND','TRIP_DECISION_TASK_NOT_FOUND',
                           'TRIP_RISK_NOT_FOUND','TRIP_ASSIGNEE_NOT_CREW'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2766: % survived', t; END IF;
  END LOOP;

  -- The post-2765 kernel must be INTACT, not merely goal-free.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','REMOVE_COMMITMENT',
                           'SET_TRIP_COVER','REMOVE_PLAN','JOIN_VIA_LINK','CREATE_TRIP',
                           'TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2766: % lost — the excision overran', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION 'rollback 2766: the %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2766: expected the 2 trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
