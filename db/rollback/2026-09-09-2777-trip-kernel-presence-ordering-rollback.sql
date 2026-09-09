-- Rollback for 2777_trip_kernel_presence_ordering.sql
--
-- Removes the ordering guard from SET_PRESENCE, returning it to 2768's
-- unconditional upsert.
--
-- READ THIS BEFORE RUNNING IT. After this file, a DELAYED observation
-- overwrites a NEWER one again: a queued mobile write or a reconnecting client
-- flushing its buffer moves observed_at BACKWARDS while leaving a fresh
-- expires_at, and 2776's freshness function reads exactly the field that write
-- corrupted. The map then draws a stale location as current, which is the §10.2
-- rule this migration exists to keep. Nothing else in the system detects it.
--
-- ORDER: independent of 2776's — this file touches only the kernel, 2776's only
-- the view. Either order works.
--
-- DATA: none.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2777: trip_kernel_execute not found'; END IF;
  before_len := length(d);

  IF position('STALE_OBSERVATION' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2777: not applied here';
  END IF;

  -- 3. the result reporting
  d := replace(d, $a$        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_presence_applied := v_n > 0;
        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at,
                                       'applied', v_presence_applied,
                                       'reason', CASE WHEN v_presence_applied THEN NULL
                                                      ELSE 'STALE_OBSERVATION' END);$a$,
                  $a$        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at);$a$);

  -- 2. the guard
  d := regexp_replace(d,
       $a$            source         = EXCLUDED\.source\n(          --[^\n]*\n)*          WHERE EXCLUDED\.observed_at >= public\.trip_presence\.observed_at;$a$,
       $a$            source         = EXCLUDED.source;$a$,
       '');
  IF position('WHERE EXCLUDED.observed_at' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2777: the guard did not come out';
  END IF;

  -- 1. the local
  d := replace(d, E'  v_presence_applied boolean;\n', '');

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2777: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['STALE_OBSERVATION','v_presence_applied','WHERE EXCLUDED.observed_at'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2777: % survived', t; END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['SET_PRESENCE','CLEAR_PRESENCE','VOTE_ON_PROPOSAL','ADD_STAGE',
                           'JOIN_PLAN','RECORD_OUTCOME','CREATE_TRIP','TRIP_VERSION_CONFLICT',
                           'trip_command_receipts','trip_outbox','ON CONFLICT (trip_id, user_id) DO UPDATE'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2777: % lost — the excision overran', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'v_family     := ''presence'';', ''))) / length('v_family     := ''presence'';');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2777: expected 2 presence-family assignments, found %', n; END IF;
  -- The branch count must be UNCHANGED. This file removes a guard, not a
  -- branch, and an excision that took one would satisfy every check above.
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 50 THEN RAISE EXCEPTION 'rollback 2777: expected 50 command branches, found % — the excision overran', n; END IF;

  IF to_regclass('public.trip_presence_current') IS NOT NULL THEN
    RAISE WARNING 'rollback 2777: trip_presence_current still labels rows by observed_at, and the kernel no longer protects that column from a delayed write. A stale observation can now move it backwards and the view will report the result as live.';
  END IF;
END
$post$;

COMMIT;
