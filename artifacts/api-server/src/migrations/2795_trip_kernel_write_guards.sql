-- 2795_trip_kernel_write_guards.sql
--
-- Trips spec §4.1 "the kernel validates schema … temporal consistency",
-- §7.2 "confirmed timelines may contain known conflicts only when explicitly
-- overridden and visibly", Appendix B TRIP_IDENTITY_* / TRIP_TEMPORAL_*.
-- census-trips TR450 (closes §35's TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT),
-- TR54 ("overlap still not").
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- 1. CREATE_TRIP's INSERT was the one unguarded write in the kernel: a draft
--    with no destination_city (which POST /trips sends) hit the column's NOT
--    NULL and the 23502 escaped the function, so executeTripCommand reported
--    TRIP_KERNEL_UNAVAILABLE — "try again" — for a command that can never
--    succeed (§35, measured). Every other family wraps its INSERT.
-- 2. 2779 refuses a MOVE_PLAN / UPDATE_PLAN whose interval overlaps a
--    commitment's approach window (TRIP_TEMPORAL_CONFLICT unless
--    override_conflicts). Two PLANS overlapping was reported by the freedom
--    engine (PLAN_OVERLAP) and never refused at the write (TR54).
--
-- WHAT THIS FILE CHANGES (transform, 2764's method)
-- ==================================================
--   CREATE_TRIP   the INSERT runs inside an exception block: not_null_violation,
--                 check_violation, invalid_text_representation and
--                 datetime_field_overflow return TRIP_COMMAND_MALFORMED with the
--                 database's own sentence; unique_violation on the id returns
--                 TRIP_IDENTITY_ALREADY_EXISTS. A draft with no city is refused
--                 by name and never retried.
--   ADD_PLAN      a new plan whose interval overlaps a CONFIRMED or IN_PROGRESS
--                 plan of the same trip is TRIP_TEMPORAL_CONFLICT naming the
--                 plan — unless override_conflicts: true, which is recorded on
--                 the result (and so on the event) as it is for a commitment.
--   MOVE/UPDATE   the same rule, in 2779's guard, beside the commitment check.
--
-- Nothing is rewritten; every anchor is counted before it is replaced and the
-- function is re-read after. No table, no column, no flag.

BEGIN;

DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int; family_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2795: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  family_before   := (length(d) - length(replace(d, 'v_family     := ''', ''))) / length('v_family     := ''');
  IF position('2795 / §4.1' in d) > 0 THEN
    RAISE EXCEPTION '2795: already applied; this migration is not idempotent by design';
  END IF;
  IF position('override_conflicts' in d) = 0 THEN
    RAISE EXCEPTION '2795: the installed kernel has no 2779 override guard (override_conflicts); apply 2779 first';
  END IF;

  -- declarations
  n := (length(d) - length(replace(d, '  v_cp         record;', ''))) / length('  v_cp         record;');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor v_cp occurs % times, expected 1 (apply 2794 first)', n; END IF;
  d := replace(d, '  v_cp         record;',
                  '  v_cp         record;' || E'\n' ||
                  '  v_overlap_id uuid;' || E'\n' ||
                  '  v_add_starts timestamptz;' || E'\n' ||
                  '  v_add_ends   timestamptz;');

  -- 1. CREATE_TRIP: the INSERT inside an exception block
  n := (length(d) - length(replace(d, E'    INSERT INTO public.trips (\n      id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility,', ''))) / length(E'    INSERT INTO public.trips (\n      id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility,');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor CREATE_TRIP insert occurs % times, expected 1', n; END IF;
  d := replace(d, E'    INSERT INTO public.trips (\n      id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility,',
                  E'    -- 2795 / §4.1: the one unguarded write, guarded. A malformed draft is refused by name, not reported as an outage (§35).\n' ||
                  E'    BEGIN\n' ||
                  E'    INSERT INTO public.trips (\n      id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility,');
  n := (length(d) - length(replace(d, E'    RETURNING * INTO v_trip;\n    v_current    := 0;', ''))) / length(E'    RETURNING * INTO v_trip;\n    v_current    := 0;');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor CREATE_TRIP returning occurs % times, expected 1', n; END IF;
  d := replace(d, E'    RETURNING * INTO v_trip;\n    v_current    := 0;',
$ct$    RETURNING * INTO v_trip;
    EXCEPTION
      WHEN not_null_violation OR check_violation OR invalid_text_representation OR datetime_field_overflow OR string_data_right_truncation THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
      WHEN unique_violation THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_IDENTITY_ALREADY_EXISTS', 'detail', SQLERRM, 'contract_version', 2);
    END;
    v_current    := 0;$ct$);

  -- 2. MOVE_PLAN / UPDATE_PLAN: a plan may not overlap a confirmed plan either (2779's guard, extended)
  n := (length(d) - length(replace(d, E'            IF v_conflict_id IS NOT NULL THEN\n              IF coalesce((v_payload->>''override_conflicts'')::boolean, false) THEN\n                v_overridden := true;', ''))) / length(E'            IF v_conflict_id IS NOT NULL THEN\n              IF coalesce((v_payload->>''override_conflicts'')::boolean, false) THEN\n                v_overridden := true;');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor 2779 conflict check occurs % times, expected 1', n; END IF;
  d := replace(d, E'            IF v_conflict_id IS NOT NULL THEN\n              IF coalesce((v_payload->>''override_conflicts'')::boolean, false) THEN\n                v_overridden := true;',
$mv$            -- 2795 / §7.2 (TR54): nor may it overlap another CONFIRMED or IN_PROGRESS plan of this trip.
            v_overlap_id := NULL;
            SELECT p.id INTO v_overlap_id
              FROM public.trip_plan_items p
             WHERE p.trip_id = v_trip_id AND p.id <> v_item_id AND p.removed_at IS NULL
               AND p.status IN ('confirmed', 'in_progress')
               AND p.starts_at IS NOT NULL
               AND tstzrange(p.starts_at, greatest(coalesce(p.ends_at, p.starts_at), p.starts_at), '[)')
                   && tstzrange(v_plan_starts, greatest(coalesce(v_plan_ends, v_plan_starts), v_plan_starts), '[)')
             ORDER BY p.starts_at
             LIMIT 1;
            IF v_overlap_id IS NOT NULL THEN
              IF coalesce((v_payload->>'override_conflicts')::boolean, false) THEN
                v_overridden := true;
              ELSE
                RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_CONFLICT',
                  'plan_id', v_overlap_id, 'detail', 'the new interval overlaps a confirmed plan; resend with override_conflicts: true to keep both and have the override recorded',
                  'contract_version', 2);
              END IF;
            END IF;
            IF v_conflict_id IS NOT NULL THEN
              IF coalesce((v_payload->>'override_conflicts')::boolean, false) THEN
                v_overridden := true;$mv$);
  -- the override on the result names the plan when it was a plan
  n := (length(d) - length(replace(d, E'        IF v_overridden THEN\n          v_result := v_result || jsonb_build_object(''temporal_conflict'',\n            jsonb_build_object(''commitment_id'', v_conflict_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT''));\n        END IF;', ''))) / length(E'        IF v_overridden THEN\n          v_result := v_result || jsonb_build_object(''temporal_conflict'',\n            jsonb_build_object(''commitment_id'', v_conflict_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT''));\n        END IF;');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor 2779 override result occurs % times, expected 1', n; END IF;
  d := replace(d, E'        IF v_overridden THEN\n          v_result := v_result || jsonb_build_object(''temporal_conflict'',\n            jsonb_build_object(''commitment_id'', v_conflict_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT''));\n        END IF;',
$rs$        IF v_overridden THEN
          v_result := v_result || jsonb_build_object('temporal_conflict',
            jsonb_strip_nulls(jsonb_build_object('commitment_id', v_conflict_id, 'plan_id', v_overlap_id, 'overridden', true, 'reason', 'TRIP_TEMPORAL_CONFLICT')));
        END IF;$rs$);
  -- jsonb_strip_nulls: `plan_id` is on the result only when the override named
  -- a plan. A commitment override keeps 2779's recorded shape exactly
  -- ({commitment_id, overridden, reason}) — src/test/db/tripPlanLifecycle.db.test.ts
  -- pins it, and a `plan_id: null` beside it was the one thing this migration
  -- changed for a caller that never asked about plans.

  -- 3. ADD_PLAN: the same rule before the INSERT (after 2780's subgroup block)
  n := (length(d) - length(replace(d, E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,', ''))) / length(E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor ADD_PLAN insert occurs % times, expected 1', n; END IF;
  d := replace(d, E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,',
$ap$        -- 2795 / §7.2 (TR54): a new plan may not overlap a CONFIRMED or IN_PROGRESS plan unless overridden by name.
        v_overlap_id := NULL; v_overridden := false; v_add_starts := NULL; v_add_ends := NULL;
        BEGIN
          v_add_starts := NULLIF(v_payload->>'starts_at', '')::timestamptz;
          v_add_ends   := NULLIF(v_payload->>'ends_at', '')::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation OR datetime_field_overflow THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        IF v_add_starts IS NOT NULL THEN
          SELECT p.id INTO v_overlap_id
            FROM public.trip_plan_items p
           WHERE p.trip_id = v_trip_id AND p.removed_at IS NULL
             AND p.status IN ('confirmed', 'in_progress')
             AND p.starts_at IS NOT NULL
             AND tstzrange(p.starts_at, greatest(coalesce(p.ends_at, p.starts_at), p.starts_at), '[)')
                 && tstzrange(v_add_starts, greatest(coalesce(v_add_ends, v_add_starts), v_add_starts), '[)')
           ORDER BY p.starts_at
           LIMIT 1;
          IF v_overlap_id IS NOT NULL THEN
            IF coalesce((v_payload->>'override_conflicts')::boolean, false) THEN
              v_overridden := true;
            ELSE
              RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_CONFLICT',
                'plan_id', v_overlap_id, 'detail', 'the new plan overlaps a confirmed plan; resend with override_conflicts: true to keep both and have the override recorded',
                'contract_version', 2);
            END IF;
          END IF;
        END IF;
        INSERT INTO public.trip_plan_items (
          trip_id, creator_id, title, category, status, source_type, source_id,$ap$);

  -- 4. ADD_PLAN: the override is a fact the event must carry (as 2779 records it for a move)
  n := (length(d) - length(replace(d, E'        v_event_type := ''trip.plan_added'';\n        v_result := to_jsonb(v_row);', ''))) / length(E'        v_event_type := ''trip.plan_added'';\n        v_result := to_jsonb(v_row);');
  IF n <> 1 THEN RAISE EXCEPTION '2795: anchor ADD_PLAN result occurs % times, expected 1', n; END IF;
  d := replace(d, E'        v_event_type := ''trip.plan_added'';\n        v_result := to_jsonb(v_row);',
                  E'        v_event_type := ''trip.plan_added'';\n        v_result := to_jsonb(v_row);\n' ||
                  E'        IF v_overridden THEN v_result := v_result || jsonb_build_object(''temporal_conflict'', jsonb_build_object(''plan_id'', v_overlap_id, ''overridden'', true, ''reason'', ''TRIP_TEMPORAL_CONFLICT'')); END IF;');

  EXECUTE d;

  -- This migration adds no command branch and must remove none either, and it
  -- touches no family: both counts are pinned to what 2794 left (66 branches,
  -- 44 family assignments) and to the base's own counts, so an anchor that
  -- matched somewhere unintended is refused here rather than applied.
  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before THEN
    RAISE EXCEPTION '2795: the transform changed the command branch count by %, expected 0', branches_after - branches_before;
  END IF;
  IF branches_after <> 66 THEN RAISE EXCEPTION '2795: expected 66 command branches after a no-branch migration, found %', branches_after; END IF;
  n := (length(d) - length(replace(d, 'v_family     := ''', ''))) / length('v_family     := ''');
  IF n <> family_before THEN RAISE EXCEPTION '2795: the transform changed the family assignments % -> %', family_before, n; END IF;
  -- 44, not 41: 2779 as amended in §43 (a63d5bf5b) declares five families where
  -- its first cut declared two. A replica that applied 2779 before that
  -- amendment reports 41 and is STALE — the same chain replayed from the
  -- baseline (scripts/local-db/up.sh, as CI's throwaway job does) reports 44.
  -- The pin is to the chain, never to whichever replica happened to be at hand.
  IF n <> 44 THEN RAISE EXCEPTION '2795: expected 44 family assignments after 2794, found %', n; END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2795: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('2795 / §4.1' in d) = 0 THEN RAISE EXCEPTION '2795: CREATE_TRIP guard missing after apply'; END IF;
  IF position('WHEN not_null_violation OR check_violation' in d) = 0 THEN RAISE EXCEPTION '2795: the exception block is missing'; END IF;
  n := (length(d) - length(replace(d, 'overlaps a confirmed plan', ''))) / length('overlaps a confirmed plan');
  IF n <> 2 THEN RAISE EXCEPTION '2795: expected the plan-overlap refusal twice (ADD_PLAN, MOVE/UPDATE), found %', n; END IF;
  n := (length(d) - length(replace(d, '''plan_id'', v_overlap_id, ''overridden'', true', ''))) / length('''plan_id'', v_overlap_id, ''overridden'', true');
  IF n <> 2 THEN RAISE EXCEPTION '2795: expected the override to name the plan on both results (ADD_PLAN, MOVE/UPDATE), found %', n; END IF;
  -- What this migration did not name must have survived it.
  FOREACH t IN ARRAY ARRAY['TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox',
                           'TRIP_IDENTITY_ALREADY_EXISTS', 'override_conflicts', 'RECORD_OUTCOME', 'CREATE_MEETING_CHECKPOINT'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2795: % lost — the transform dropped what it did not name', t; END IF;
  END LOOP;
END
$post$;

COMMIT;
