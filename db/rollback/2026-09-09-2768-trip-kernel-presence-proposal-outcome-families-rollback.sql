-- Rollback for 2768_trip_kernel_presence_proposal_outcome_families.sql
--
-- Removes SET_PRESENCE, CLEAR_PRESENCE, CREATE_PROPOSAL, ACCEPT_PROPOSAL,
-- REJECT_PROPOSAL and RECORD_OUTCOME from trip_kernel_execute, returning the
-- function to its post-2766 shape.
--
-- ORDER: before the 2766 rollback, which is before 2765's, which is before
-- 2764's. The excision is anchored on the ADD_GOAL branch.
--
-- DATA: none. trip_presence, trip_proposals and trip_outcomes rows are
-- untouched — this removes the writer, not the tables.
--
-- Rehearsed on db/harness/run.sh.

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
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2768: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('SET_PRESENCE' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2768: the presence family is not present; 2768 was never applied here';
  END IF;
  IF position('ADD_GOAL' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2768: the goal family is gone, so the excision has no terminator. The 2766 rollback was run first; that ordering is wrong.';
  END IF;

  -- 3. The six branches, reversed first.
  d := regexp_replace(
         d,
         $a$      WHEN 'SET_PRESENCE' THEN.*?      WHEN 'ADD_GOAL' THEN$a$,
         $a$      WHEN 'ADD_GOAL' THEN$a$,
         -- No 'n' flag: 'n' makes '.' STOP matching newline in Postgres ARE.
         '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 6 THEN
    RAISE EXCEPTION 'rollback 2768: the excision removed % command branches, expected exactly 6', branches_before - n;
  END IF;

  -- 2. The capability dispatch — three lines, removed as one block.
  n := (length(d) - length(replace(d, $a$WHEN 'RECORD_OUTCOME' THEN 'crew'$a$, ''))) / length($a$WHEN 'RECORD_OUTCOME' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2768: the dispatch block occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'SET_PRESENCE' THEN 'crew' WHEN 'CLEAR_PRESENCE' THEN 'crew'
    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'
    WHEN 'RECORD_OUTCOME' THEN 'crew'
$a$, '');

  -- 1. The declarations.
  FOREACH t IN ARRAY ARRAY['  v_proposal_id uuid;', '  v_proposal_status text;',
                           '  v_outcome_id uuid;', '  v_observed_at timestamptz;',
                           '  v_expires_at  timestamptz;'] LOOP
    n := (length(d) - length(replace(d, t, ''))) / length(t);
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2768: the declaration % occurs % times, expected 1', t, n; END IF;
    d := replace(d, t || E'\n', '');
  END LOOP;

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2768: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['SET_PRESENCE','CLEAR_PRESENCE','CREATE_PROPOSAL','ACCEPT_PROPOSAL',
                           'REJECT_PROPOSAL','RECORD_OUTCOME','v_proposal_id','v_outcome_id',
                           'v_observed_at','v_expires_at','trip.presence_','trip.proposal_',
                           'trip.outcome_','TRIP_PRESENCE_NOT_SELF','TRIP_PRESENCE_NOT_FOUND',
                           'TRIP_PROPOSAL_NOT_FOUND','TRIP_PROPOSAL_NOT_PENDING'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2768: % survived', t; END IF;
  END LOOP;

  -- The post-2766 kernel must be INTACT, not merely presence-free.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','ADD_GOAL','ADD_RISK',
                           'ADD_DECISION_TASK','SET_TRIP_COVER','REMOVE_PLAN','JOIN_VIA_LINK',
                           'CREATE_TRIP','TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2768: % lost — the excision overran', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION 'rollback 2768: the %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2768: expected the 2 trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
