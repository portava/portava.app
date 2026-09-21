-- 2777_trip_kernel_presence_ordering.sql
--
-- The kernel half of the §10 work 2776 began: SET_PRESENCE stops letting a
-- DELAYED observation overwrite a NEWER one.
--
-- THE DEFECT
-- ==========
-- 2768's SET_PRESENCE is `ON CONFLICT (trip_id, user_id) DO UPDATE SET ...`
-- with no comparison of observed_at. So a write that was delayed in flight — a
-- queued mobile write, a retried request, a reconnecting client flushing its
-- buffer — replaces a newer observation with an older one. The row then says
-- the traveller is where they were ten minutes ago, carrying a fresh-looking
-- expires_at, and nothing downstream can tell: 2776's freshness function reads
-- observed_at, and observed_at is exactly what the stale write just moved
-- backwards.
--
-- §10.2: "The Trip Map must never draw a stale location as if it were current."
-- Silent last-write-wins is how a stale location becomes the current one.
--
-- THE FIX, AND WHY IT IS NOT AN ERROR
-- ===================================
--   ON CONFLICT ... DO UPDATE SET ... WHERE EXCLUDED.observed_at >= trip_presence.observed_at
--
-- An ignored write is NOT a failure. The client did nothing wrong; retrying is
-- correct behaviour and is what produced the duplicate. So the command still
-- SUCCEEDS and the result carries `applied: false` with
-- `reason: STALE_OBSERVATION`, and the event records it. Returning a refusal
-- would make a well-behaved retry look like an outage and would push clients
-- toward not retrying, which is worse.
--
-- >= AND NOT >. Two observations at the same instant are the same observation
-- as far as ordering is concerned, and the later WRITE is the one to keep: a
-- client correcting a state it reported a moment ago at the same observed_at
-- must not be silently ignored. Only a STRICTLY older observation loses.
--
-- BASE: the post-2775 kernel.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2777 (Trips).

BEGIN;

DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2777: trip_kernel_execute not found'; END IF;
  IF position('SET_PRESENCE' in d) = 0 THEN
    RAISE EXCEPTION '2777: the installed kernel has no presence family; apply 2768 first';
  END IF;
  IF position('VOTE_ON_PROPOSAL' in d) = 0 THEN
    RAISE EXCEPTION '2777: the installed kernel predates 2775';
  END IF;
END
$base$;

DO $mig$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('STALE_OBSERVATION' in d) > 0 THEN
    RAISE EXCEPTION '2777: already applied; this migration is not idempotent by design';
  END IF;

  -- 1. a local to carry whether the upsert took
  n := (length(d) - length(replace(d, '  v_expires_at  timestamptz;', ''))) / length('  v_expires_at  timestamptz;');
  IF n <> 1 THEN RAISE EXCEPTION '2777: anchor v_expires_at occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_expires_at  timestamptz;',
                  '  v_expires_at  timestamptz;' || E'\n' ||
                  '  v_presence_applied boolean;');

  -- 2. the conditional upsert
  n := (length(d) - length(replace(d, $a$          ON CONFLICT (trip_id, user_id) DO UPDATE SET
            presence_state = EXCLUDED.presence_state,
            visibility     = EXCLUDED.visibility,
            observed_at    = EXCLUDED.observed_at,
            expires_at     = EXCLUDED.expires_at,
            confidence     = EXCLUDED.confidence,
            source         = EXCLUDED.source;$a$, ''))) /
       length($a$          ON CONFLICT (trip_id, user_id) DO UPDATE SET
            presence_state = EXCLUDED.presence_state,
            visibility     = EXCLUDED.visibility,
            observed_at    = EXCLUDED.observed_at,
            expires_at     = EXCLUDED.expires_at,
            confidence     = EXCLUDED.confidence,
            source         = EXCLUDED.source;$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2777: anchor SET_PRESENCE upsert occurs % times, expected 1', n; END IF;
  d := replace(d, $a$          ON CONFLICT (trip_id, user_id) DO UPDATE SET
            presence_state = EXCLUDED.presence_state,
            visibility     = EXCLUDED.visibility,
            observed_at    = EXCLUDED.observed_at,
            expires_at     = EXCLUDED.expires_at,
            confidence     = EXCLUDED.confidence,
            source         = EXCLUDED.source;$a$,
                  $a$          ON CONFLICT (trip_id, user_id) DO UPDATE SET
            presence_state = EXCLUDED.presence_state,
            visibility     = EXCLUDED.visibility,
            observed_at    = EXCLUDED.observed_at,
            expires_at     = EXCLUDED.expires_at,
            confidence     = EXCLUDED.confidence,
            source         = EXCLUDED.source
          -- 2777 / §10.2. A DELAYED observation must not overwrite a newer one:
          -- a queued mobile write or a reconnecting client flushing its buffer
          -- would otherwise move observed_at BACKWARDS while leaving a fresh
          -- expires_at, and 2776's freshness function reads exactly the field
          -- the stale write just corrupted.
          -- >= and not >: two observations at one instant are one observation
          -- for ordering, and the later WRITE should win — a client correcting
          -- a state it reported a moment ago must not be silently ignored.
          WHERE EXCLUDED.observed_at >= public.trip_presence.observed_at;$a$);

  -- 3. report which happened. An ignored write is a SUCCESS with applied:false,
  --    not a refusal: retrying is correct behaviour and is what caused it.
  n := (length(d) - length(replace(d, $a$        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at);$a$, ''))) /
       length($a$        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at);$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2777: anchor SET_PRESENCE result occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at);$a$,
                  $a$        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_presence_applied := v_n > 0;
        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at,
                                       'applied', v_presence_applied,
                                       'reason', CASE WHEN v_presence_applied THEN NULL
                                                      ELSE 'STALE_OBSERVATION' END);$a$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2777: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before THEN
    RAISE EXCEPTION '2777: the transform changed the command branch count by %, expected 0', n - branches_before;
  END IF;

  EXECUTE d;
END
$mig$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  IF position('WHERE EXCLUDED.observed_at >= public.trip_presence.observed_at' in d) = 0 THEN
    RAISE EXCEPTION '2777: the ordering guard is missing after apply';
  END IF;
  IF position('STALE_OBSERVATION' in d) = 0 THEN
    RAISE EXCEPTION '2777: an ignored write does not report why';
  END IF;
  -- Strictly-greater would silently drop a same-instant correction.
  IF position('EXCLUDED.observed_at > public.trip_presence.observed_at' in d) > 0
     AND position('EXCLUDED.observed_at >= public.trip_presence.observed_at' in d) = 0 THEN
    RAISE EXCEPTION '2777: the guard is strictly-greater; a same-instant correction would be ignored';
  END IF;

  FOREACH t IN ARRAY ARRAY['SET_PRESENCE','CLEAR_PRESENCE','VOTE_ON_PROPOSAL','ADD_STAGE',
                           'JOIN_PLAN','RECORD_OUTCOME','CREATE_TRIP','TRIP_VERSION_CONFLICT',
                           'authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2777: % was lost', t; END IF;
  END LOOP;
  -- This migration adds no command branch and must remove none either. Stating
  -- the count as UNCHANGED is the same invariant every family migration
  -- carries, with a different number.
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 50 THEN RAISE EXCEPTION '2777: expected 50 command branches after a no-branch migration, found %', n; END IF;
  n := (length(d) - length(replace(d, 'v_family     := ''presence'';', ''))) / length('v_family     := ''presence'';');
  IF n <> 2 THEN RAISE EXCEPTION '2777: expected 2 presence-family assignments, found %', n; END IF;
END
$post$;

COMMIT;
