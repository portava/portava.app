-- 2764_trip_kernel_stage_family.sql
--
-- Trips v4 §4: the ADD_STAGE / UPDATE_STAGE / REMOVE_STAGE command family, so
-- that `trip_stages` (2760) has the writer §4 requires and census-trips TR78 can
-- close. Every §5 table is writerless until its family lands; this is the first.
--
-- NOT REHEARSED ON ANY SUPABASE DATABASE. READ THIS BEFORE APPLYING IT.
-- ====================================================================
-- Measured 2026-09-09, read-only, on BOTH databases:
--
--                          repo (2590)   portava-ci   production
--   trip_kernel_execute      44,343 ch    11,314 ch    11,976 ch
--   SET_TRIP_COVER present      yes          no           no
--   CREATE_TRIP present         yes          no           no
--   JOIN_VIA_LINK present       yes          no           no
--
-- Both databases carry 2420's ORIGINAL plan-family-only kernel. Migrations
-- 2450, 2500 and 2590 have NEVER been applied to either — confirmed against
-- portava-ci's supabase_migrations.schema_migrations, which lists 2420 and none
-- of the three. So the trip family, the participant family, JOIN_VIA_LINK and
-- 2590's attachment columns exist only in this repository.
--
-- This migration therefore cannot be rehearsed on Supabase yet: applying it to
-- either database would graft the stage family onto 2420 and silently produce a
-- kernel missing everything 2450/2500/2590 added. That is not hypothetical — it
-- was attempted against portava-ci and REFUSED by the anchor assertion below,
-- which is the only reason this file is honest rather than damaging.
--
-- PREREQUISITE: apply 2450 -> 2500 -> 2590, in order, then this.
--
-- WHAT IT *WAS* REHEARSED ON, AND WHAT THAT IS WORTH
-- ==================================================
-- db/harness/run.sh — a local PostgreSQL 16 cluster built for this migration
-- because there was nowhere else to run it. It slices the 2590 function body
-- out of 2590's own file (never transcribed), runs the REAL 2760 with all its
-- postconditions, then applies this file and executes actual commands. A cold
-- run is green: apply, re-apply refused, sixteen behavioural probes, rollback
-- restoring the definition BYTE-FOR-BYTE, second rollback refused.
--
-- That harness earned its cost immediately. The first draft of this file set
-- v_event_type on all three branches and v_family on none, so every stage event
-- was written into the ledger under family 'plan' — the value the kernel sets
-- before the CASE. Every contract test passed: the command names, event types
-- and reason codes all agreed with TypeScript. Only executing the command
-- found it. The postcondition counting three 'stage' assignments exists so that
-- defect cannot return silently.
--
-- What the harness does NOT establish, stated plainly because a green run is
-- easy to over-read: it is bare PostgreSQL, not Supabase. The tables other than
-- trip_stages are column-shape stubs taken from portava-ci with keys and
-- defaults added back, so a constraint that exists there and not here refuses
-- nothing here. Four enum types are text DOMAINs, so a bad enum label passes.
-- Every probe runs as superuser, so RLS is bypassed — the same bypass
-- service_role has, which is why the kernel's own writes are still meaningful,
-- and why nothing here says anything about client access. A green harness run
-- is not a portava-ci rehearsal and is not permission to touch production.
--
--
-- WHY A TRANSFORM RATHER THAN A FULL REPLACEMENT
-- ==============================================
-- 2450, 2500 and 2590 each restate trip_kernel_execute in full — 707 lines by
-- 2590. Reproducing 707 lines to change 40 of them puts the other 667 at risk of
-- transcription damage, and a diff of that shape cannot be reviewed: the reader
-- must trust that nothing else moved.
--
-- This file instead reads the deployed definition, applies three named
-- replacements, and ASSERTS EACH ANCHOR OCCURS EXACTLY ONCE before touching it.
-- What it does not name, it cannot damage. The postconditions then re-read the
-- installed function and check that the pre-existing guarantees a careless
-- rewrite would most likely have dropped are still there: the version conflict,
-- the crew capability check, the idempotency receipt, the outbox write, and
-- exactly TWO trip-level inverted-range checks.
--
-- The cost is real and accepted: you cannot read the resulting function in this
-- file. You can read exactly what changed, and pg_get_functiondef is auditable
-- after the fact.
--
-- REMOVE_STAGE is a hard DELETE, not a soft one. trip_stages carries no
-- removed_at, and adding one silently would be inventing a lifecycle the spec
-- does not describe. The cascade semantics are the ones 2760/2761/2763 already
-- prove: deleting a stage takes its LEGS and leaves its COMMITMENTS and OUTCOMES
-- with a null stage_id, because those outlive the stage they were filed under.

BEGIN;

-- Refuse to run against a base that is not 2590. This is the assertion that
-- caught the stale portava-ci kernel; without it this file would have applied
-- cleanly and produced a wrong function.
DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2764: trip_kernel_execute not found'; END IF;
  IF position('SET_TRIP_COVER' in d) = 0 THEN
    RAISE EXCEPTION '2764: the installed kernel predates 2590 (no SET_TRIP_COVER). Apply 2450 -> 2500 -> 2590 first; grafting the stage family onto 2420 would drop the trip and participant families.';
  END IF;
  IF position('added_by' in d) = 0 THEN
    RAISE EXCEPTION '2764: the installed kernel predates 2590 (no added_by). Apply 2590 first.';
  END IF;
  -- UPDATE_STAGE reuses the kernel's existing v_patch rather than declaring a
  -- second patch variable. If a future kernel renames it this must fail here,
  -- loudly, rather than at the first UPDATE_STAGE call in production.
  IF position('v_patch      jsonb;' in d) = 0 THEN
    RAISE EXCEPTION '2764: the installed kernel does not declare v_patch; UPDATE_STAGE below reuses it';
  END IF;
END
$base$;

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2764: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  -- Every command branch begins with exactly six spaces and WHEN. Counting them
  -- before and after turns "did the insert land where it should" into an exact
  -- test: three commands must produce three new branches, no more, no fewer.
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('ADD_STAGE' in d) > 0 THEN
    RAISE EXCEPTION '2764: the stage family is already present; this migration is not idempotent by design';
  END IF;

  -- 1. declare the stage id
  n := (length(d) - length(replace(d, '  v_item_id    uuid;', ''))) / length('  v_item_id    uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2764: anchor v_item_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_item_id    uuid;',
                  '  v_item_id    uuid;' || E'\n' ||
                  '  v_stage_id   uuid;');

  -- 2. capability dispatch
  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2764: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''ADD_STAGE'' THEN ''crew'' WHEN ''UPDATE_STAGE'' THEN ''crew'' WHEN ''REMOVE_STAGE'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- 3. the branches
  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2764: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'ADD_STAGE' THEN
        IF coalesce(v_payload->>'stage_type','') = ''
           OR coalesce(v_payload->>'timezone','') = ''
           OR (v_payload->>'sequence') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'stage_type, timezone and sequence are required', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_stages
            (trip_id, stage_type, place_id, city_id, timezone, starts_at, ends_at, state, sequence)
          VALUES (v_trip_id, v_payload->>'stage_type',
                  (v_payload->>'place_id')::uuid, (v_payload->>'city_id')::uuid,
                  v_payload->>'timezone',
                  (v_payload->>'starts_at')::timestamptz, (v_payload->>'ends_at')::timestamptz,
                  coalesce(v_payload->>'state','planned'),
                  (v_payload->>'sequence')::integer)
          RETURNING id INTO v_stage_id;
        EXCEPTION
          WHEN unique_violation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_SEQUENCE_TAKEN',
              'sequence', v_payload->>'sequence', 'contract_version', 2);
          WHEN check_violation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
              'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'stage';
        v_event_type := 'trip.stage_added';
        v_result := jsonb_build_object('id', v_stage_id);

      WHEN 'UPDATE_STAGE' THEN
        v_stage_id := (v_payload->>'stage_id')::uuid;
        v_patch    := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_stage_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_stages
         WHERE id = v_stage_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_stages SET
            stage_type = CASE WHEN v_patch ? 'stage_type' THEN v_patch->>'stage_type'                     ELSE stage_type END,
            place_id   = CASE WHEN v_patch ? 'place_id'   THEN (v_patch->>'place_id')::uuid               ELSE place_id   END,
            city_id    = CASE WHEN v_patch ? 'city_id'    THEN (v_patch->>'city_id')::uuid                ELSE city_id    END,
            timezone   = CASE WHEN v_patch ? 'timezone'   THEN v_patch->>'timezone'                       ELSE timezone   END,
            starts_at  = CASE WHEN v_patch ? 'starts_at'  THEN (v_patch->>'starts_at')::timestamptz       ELSE starts_at  END,
            ends_at    = CASE WHEN v_patch ? 'ends_at'    THEN (v_patch->>'ends_at')::timestamptz         ELSE ends_at    END,
            state      = CASE WHEN v_patch ? 'state'      THEN v_patch->>'state'                          ELSE state      END,
            sequence   = CASE WHEN v_patch ? 'sequence'   THEN (v_patch->>'sequence')::integer            ELSE sequence   END,
            updated_at = now()
          WHERE id = v_stage_id AND trip_id = v_trip_id;
        EXCEPTION
          WHEN unique_violation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_SEQUENCE_TAKEN', 'contract_version', 2);
          WHEN check_violation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
              'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'stage';
        v_event_type := 'trip.stage_updated';
        v_result := jsonb_build_object('id', v_stage_id);

      WHEN 'REMOVE_STAGE' THEN
        v_stage_id := (v_payload->>'stage_id')::uuid;
        IF v_stage_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_stages WHERE id = v_stage_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'stage';
        v_event_type := 'trip.stage_removed';
        v_result := jsonb_build_object('id', v_stage_id);

      WHEN 'REMOVE_PLAN' THEN$branches$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2764: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 3 THEN
    RAISE EXCEPTION '2764: the transform added % command branches, expected exactly 3', n - branches_before;
  END IF;

  EXECUTE d;
END
$mig$;

DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  IF position('ADD_STAGE' in d) = 0 THEN RAISE EXCEPTION '2764: ADD_STAGE missing after apply'; END IF;
  IF position('UPDATE_STAGE' in d) = 0 THEN RAISE EXCEPTION '2764: UPDATE_STAGE missing'; END IF;
  IF position('REMOVE_STAGE' in d) = 0 THEN RAISE EXCEPTION '2764: REMOVE_STAGE missing'; END IF;
  IF position('trip.stage_added' in d) = 0 THEN RAISE EXCEPTION '2764: trip.stage_added missing'; END IF;
  IF position('TRIP_STAGE_SEQUENCE_TAKEN' in d) = 0 THEN RAISE EXCEPTION '2764: sequence-taken reason missing'; END IF;
  IF position('TRIP_STAGE_NOT_FOUND' in d) = 0 THEN RAISE EXCEPTION '2764: not-found reason missing'; END IF;
  -- Every branch must set v_family. The kernel sets it to 'plan' before the
  -- CASE and each non-plan branch overrides it; a stage branch that forgets
  -- files its events under the plan family and nothing downstream notices.
  -- This is not hypothetical: the first draft of this migration did exactly
  -- that, and only executing the command found it.
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  IF n <> 3 THEN RAISE EXCEPTION '2764: expected 3 stage-family assignments, found %', n; END IF;

  -- The parts NOT named by the transform must survive verbatim. These are the
  -- pre-existing guarantees a careless full-file retype would have been most
  -- likely to damage.
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2764: version conflict lost'; END IF;
  IF position('authz.is_accepted_trip_member' in d) = 0 THEN RAISE EXCEPTION '2764: crew capability check lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION '2764: idempotency receipt lost'; END IF;
  IF position('trip_outbox' in d) = 0 THEN RAISE EXCEPTION '2764: outbox write lost'; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION '2764: expected the 2 pre-existing trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
