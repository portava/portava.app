-- Rollback for 2795_trip_kernel_write_guards.sql
--
-- Removes the CREATE_TRIP exception block and the plan-overlap refusals from
-- trip_kernel_execute, and the three locals 2795 declared.
--
-- READ THIS BEFORE RUNNING IT. After this file:
--   * a CREATE_TRIP with no destination_city raises 23502 out of the function
--     again and executeTripCommand reports TRIP_KERNEL_UNAVAILABLE (§35's
--     TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT is open again);
--   * ADD_PLAN / MOVE_PLAN / UPDATE_PLAN no longer refuse an overlap with a
--     confirmed plan; 2779's commitment guard is untouched.
--   Events already recorded with temporal_conflict.plan_id survive.
--
-- ORDER: any time after 2795. Nothing later depends on it.
-- DATA: none.
-- Rehearsed on scripts/local-db (apply 2795 → this file → 2795 again).

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2795: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  IF position('2795 / §4.1' in d) = 0 THEN RAISE EXCEPTION 'rollback 2795: not applied here'; END IF;

  -- 1. CREATE_TRIP: the comment + BEGIN, and the EXCEPTION block
  d := replace(d, E'    -- 2795 / §4.1: the one unguarded write, guarded. A malformed draft is refused by name, not reported as an outage (§35).\n    BEGIN\n    INSERT INTO public.trips (', E'    INSERT INTO public.trips (');
  d := regexp_replace(d, $a$    RETURNING \* INTO v_trip;\n    EXCEPTION\n.*?\n    END;\n    v_current    := 0;$a$, $a$    RETURNING * INTO v_trip;
    v_current    := 0;$a$, '');

  -- 2. MOVE/UPDATE: the overlap block before 2779's conflict check
  d := regexp_replace(d, $a$            -- 2795 / §7\.2 \(TR54\): nor may it overlap.*?\n            IF v_conflict_id IS NOT NULL THEN$a$, $a$            IF v_conflict_id IS NOT NULL THEN$a$, '');
  d := replace(d, E'jsonb_strip_nulls(jsonb_build_object(''commitment_id'', v_conflict_id, ''plan_id'', v_overlap_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT''))',
                  E'jsonb_build_object(''commitment_id'', v_conflict_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT'')');

  -- 3. ADD_PLAN: the block before the INSERT
  d := regexp_replace(d, $a$        -- 2795 / §7\.2 \(TR54\): a new plan may not overlap.*?\n        INSERT INTO public\.trip_plan_items \($a$, $a$        INSERT INTO public.trip_plan_items ($a$, '');

  -- 3b. ADD_PLAN: the override on the result
  d := replace(d, E'\n        IF v_overridden THEN v_result := v_result || jsonb_build_object(''temporal_conflict'', jsonb_build_object(''plan_id'', v_overlap_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT'')); END IF;', '');

  -- 4. locals
  d := replace(d, E'  v_overlap_id uuid;\n', '');
  d := replace(d, E'  v_add_starts timestamptz;\n', '');
  d := replace(d, E'  v_add_ends   timestamptz;\n', '');

  IF length(d) >= before_len THEN RAISE EXCEPTION 'rollback 2795: the inverse transform did not shrink the definition'; END IF;
  EXECUTE d;
END
$rb$;

DO $post$
DECLARE d text; t text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  FOREACH t IN ARRAY ARRAY['2795 / §4.1', '2795 / §7.2', 'overlaps a confirmed plan', 'v_overlap_id', 'v_add_starts', 'v_add_ends', 'WHEN not_null_violation OR check_violation'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2795: % survived', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['override_conflicts', 'TRIP_TEMPORAL_CONFLICT', 'TRIP_IDENTITY_ALREADY_EXISTS', 'CREATE_MEETING_CHECKPOINT', 'trip_command_receipts',
                           'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_outbox', 'RECORD_OUTCOME', 'RETURNING * INTO v_trip;'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2795: % lost — the excision overran', t; END IF;
  END LOOP;
  -- 2795 added no branch and touched no family; the counts 2794 left must be exact.
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 66 THEN RAISE EXCEPTION 'rollback 2795: expected 66 command branches, found % — the excision overran', n; END IF;
  n := (length(d) - length(replace(d, 'v_family     := ''', ''))) / length('v_family     := ''');
  -- 44 on the canonical chain (2779 as amended in §43 declares five families); a replica that applied the first cut of 2779 reports 41 and is stale, not a different chain.
  IF n <> 44 THEN RAISE EXCEPTION 'rollback 2795: expected 44 family assignments, found % — the excision overran', n; END IF;
END
$post$;

COMMIT;
