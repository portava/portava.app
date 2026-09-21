-- 2765_trip_kernel_leg_and_commitment_families.sql
--
-- Trips v4 §4: the ADD_LEG / UPDATE_LEG / REMOVE_LEG and
-- ADD_COMMITMENT / UPDATE_COMMITMENT / REMOVE_COMMITMENT command families, so
-- that `trip_legs` and `trip_commitments` (2761) stop being tables nothing
-- writes and census-trips TR79 and TR81 have a writer to point at.
--
-- Second in the §5 sequence. 2764 gave `trip_stages` its family; these two
-- tables hang off it, and a leg is meaningless without the stages it joins.
--
-- BASE: the post-2764 kernel. This file asserts ADD_STAGE is present before it
-- touches anything, for the reason 2764's own header gives at length: a
-- transform applied to the wrong base produces a plausible-looking wrong
-- function, and the only defence is refusing to start.
--
-- NOT REHEARSED ON ANY SUPABASE DATABASE — neither portava-ci nor production
-- carries even the 2590 kernel (see docs/architecture/blocker-ledger.md,
-- TRIP_KERNEL_NEVER_DEPLOYED). Rehearsed on db/harness/run.sh, where the
-- commands are actually executed and the rollback must restore the definition
-- byte-for-byte. Read that file's header for what a green run does and does not
-- establish.
--
-- TWO DECISIONS WORTH NAMING
-- ==========================
-- 1. A leg's two stages are checked EXPLICITLY against the trip, not left to
--    the foreign key. The FK would refuse a stage that does not exist; it would
--    NOT refuse a stage that exists on a DIFFERENT trip, and a leg joining two
--    trips' stages is exactly the kind of row that reads fine and corrupts
--    every consumer downstream. The check is `id = ... AND trip_id = v_trip_id`
--    on both, and the refusal is TRIP_STAGE_NOT_FOUND.
-- 2. Removal is a hard DELETE for both tables. Neither carries a `removed_at`,
--    and adding one here would be inventing a lifecycle the spec does not
--    describe. 2761 already decided the cascade: deleting a stage deletes its
--    legs (ON DELETE CASCADE, both ends) and NULLs its commitments' stage_id
--    (ON DELETE SET NULL), because a commitment outlives the stage it was filed
--    under and a leg does not exist without both its endpoints.

BEGIN;

DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2765: trip_kernel_execute not found'; END IF;
  IF position('SET_TRIP_COVER' in d) = 0 THEN
    RAISE EXCEPTION '2765: the installed kernel predates 2590. Apply 2450 -> 2500 -> 2590 -> 2764 first.';
  END IF;
  IF position('ADD_STAGE' in d) = 0 THEN
    RAISE EXCEPTION '2765: the installed kernel predates 2764 (no stage family). Legs reference stages; apply 2764 first.';
  END IF;
  IF position('v_patch      jsonb;' in d) = 0 THEN
    RAISE EXCEPTION '2765: the installed kernel does not declare v_patch; the UPDATE branches below reuse it';
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
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('ADD_LEG' in d) > 0 OR position('ADD_COMMITMENT' in d) > 0 THEN
    RAISE EXCEPTION '2765: the leg or commitment family is already present; this migration is not idempotent by design';
  END IF;

  -- 1. the two new ids
  n := (length(d) - length(replace(d, '  v_stage_id   uuid;', ''))) / length('  v_stage_id   uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2765: anchor v_stage_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_stage_id   uuid;',
                  '  v_stage_id   uuid;' || E'\n' ||
                  '  v_leg_id     uuid;' || E'\n' ||
                  '  v_commit_id  uuid;');

  -- 2. capability dispatch. Every one is crew: a leg or a commitment is trip
  --    state, and the 2337 accepted-member rule is what guards trip state.
  n := (length(d) - length(replace(d, $a$    WHEN 'ADD_STAGE' THEN 'crew'$a$, ''))) / length($a$    WHEN 'ADD_STAGE' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2765: anchor ADD_STAGE dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_STAGE' THEN 'crew'$a$,
                  $a$    WHEN 'ADD_LEG' THEN 'crew' WHEN 'UPDATE_LEG' THEN 'crew' WHEN 'REMOVE_LEG' THEN 'crew'
    WHEN 'ADD_COMMITMENT' THEN 'crew' WHEN 'UPDATE_COMMITMENT' THEN 'crew' WHEN 'REMOVE_COMMITMENT' THEN 'crew'
    WHEN 'ADD_STAGE' THEN 'crew'$a$);

  -- 3. the branches, inserted before the stage family
  n := (length(d) - length(replace(d, E'      WHEN ''ADD_STAGE'' THEN', ''))) / length(E'      WHEN ''ADD_STAGE'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2765: anchor ADD_STAGE branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''ADD_STAGE'' THEN', $branches$      WHEN 'ADD_LEG' THEN
        IF coalesce(v_payload->>'leg_type','') = ''
           OR (v_payload->>'from_stage_id') IS NULL
           OR (v_payload->>'to_stage_id') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'leg_type, from_stage_id and to_stage_id are required', 'contract_version', 2);
        END IF;
        -- Both endpoints must be THIS trip's stages. The foreign key would
        -- accept another trip's stage; nothing downstream would survive it.
        PERFORM 1 FROM public.trip_stages
         WHERE id = (v_payload->>'from_stage_id')::uuid AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND',
            'detail', 'from_stage_id is not a stage of this trip', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_stages
         WHERE id = (v_payload->>'to_stage_id')::uuid AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND',
            'detail', 'to_stage_id is not a stage of this trip', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_legs
            (trip_id, from_stage_id, to_stage_id, leg_type, starts_at, ends_at, source_ref)
          VALUES (v_trip_id,
                  (v_payload->>'from_stage_id')::uuid, (v_payload->>'to_stage_id')::uuid,
                  v_payload->>'leg_type',
                  (v_payload->>'starts_at')::timestamptz, (v_payload->>'ends_at')::timestamptz,
                  v_payload->>'source_ref')
          RETURNING id INTO v_leg_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'leg';
        v_event_type := 'trip.leg_added';
        v_result := jsonb_build_object('id', v_leg_id);

      WHEN 'UPDATE_LEG' THEN
        v_leg_id := (v_payload->>'leg_id')::uuid;
        v_patch  := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_leg_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_legs WHERE id = v_leg_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_LEG_NOT_FOUND', 'contract_version', 2);
        END IF;
        -- A patch may not move a leg onto another trip's stages, so the same
        -- ownership check ADD_LEG makes runs again on whichever end moved.
        IF v_patch ? 'from_stage_id' THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_patch->>'from_stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        IF v_patch ? 'to_stage_id' THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_patch->>'to_stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        BEGIN
          UPDATE public.trip_legs SET
            from_stage_id = CASE WHEN v_patch ? 'from_stage_id' THEN (v_patch->>'from_stage_id')::uuid  ELSE from_stage_id END,
            to_stage_id   = CASE WHEN v_patch ? 'to_stage_id'   THEN (v_patch->>'to_stage_id')::uuid    ELSE to_stage_id   END,
            leg_type      = CASE WHEN v_patch ? 'leg_type'      THEN v_patch->>'leg_type'               ELSE leg_type      END,
            starts_at     = CASE WHEN v_patch ? 'starts_at'     THEN (v_patch->>'starts_at')::timestamptz ELSE starts_at   END,
            ends_at       = CASE WHEN v_patch ? 'ends_at'       THEN (v_patch->>'ends_at')::timestamptz   ELSE ends_at     END,
            source_ref    = CASE WHEN v_patch ? 'source_ref'    THEN v_patch->>'source_ref'             ELSE source_ref    END,
            updated_at    = now()
          WHERE id = v_leg_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'leg';
        v_event_type := 'trip.leg_updated';
        v_result := jsonb_build_object('id', v_leg_id);

      WHEN 'REMOVE_LEG' THEN
        v_leg_id := (v_payload->>'leg_id')::uuid;
        IF v_leg_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_legs WHERE id = v_leg_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_LEG_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'leg';
        v_event_type := 'trip.leg_removed';
        v_result := jsonb_build_object('id', v_leg_id);

      WHEN 'ADD_COMMITMENT' THEN
        IF coalesce(v_payload->>'type','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'type is required', 'contract_version', 2);
        END IF;
        -- stage_id is OPTIONAL (2761 made it nullable ON DELETE SET NULL), but
        -- when given it must be this trip's stage, for ADD_LEG's reason.
        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        BEGIN
          INSERT INTO public.trip_commitments
            (trip_id, stage_id, type, starts_at, required_arrival_at, place_id,
             lateness_tolerance, prep_duration, flexibility, confidence, source_ref)
          VALUES (v_trip_id, (v_payload->>'stage_id')::uuid, v_payload->>'type',
                  (v_payload->>'starts_at')::timestamptz,
                  (v_payload->>'required_arrival_at')::timestamptz,
                  (v_payload->>'place_id')::uuid,
                  (v_payload->>'lateness_tolerance')::interval,
                  (v_payload->>'prep_duration')::interval,
                  coalesce(v_payload->>'flexibility','flexible'),
                  (v_payload->>'confidence')::numeric,
                  v_payload->>'source_ref')
          RETURNING id INTO v_commit_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR numeric_value_out_of_range THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'commitment';
        v_event_type := 'trip.commitment_added';
        v_result := jsonb_build_object('id', v_commit_id);

      WHEN 'UPDATE_COMMITMENT' THEN
        v_commit_id := (v_payload->>'commitment_id')::uuid;
        v_patch     := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_commit_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_commitments
         WHERE id = v_commit_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMITMENT_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_patch ? 'stage_id' AND (v_patch->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_patch->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        BEGIN
          UPDATE public.trip_commitments SET
            stage_id            = CASE WHEN v_patch ? 'stage_id'            THEN (v_patch->>'stage_id')::uuid              ELSE stage_id            END,
            type                = CASE WHEN v_patch ? 'type'                THEN v_patch->>'type'                          ELSE type                END,
            starts_at           = CASE WHEN v_patch ? 'starts_at'           THEN (v_patch->>'starts_at')::timestamptz      ELSE starts_at           END,
            required_arrival_at = CASE WHEN v_patch ? 'required_arrival_at' THEN (v_patch->>'required_arrival_at')::timestamptz ELSE required_arrival_at END,
            place_id            = CASE WHEN v_patch ? 'place_id'            THEN (v_patch->>'place_id')::uuid              ELSE place_id            END,
            lateness_tolerance  = CASE WHEN v_patch ? 'lateness_tolerance'  THEN (v_patch->>'lateness_tolerance')::interval ELSE lateness_tolerance  END,
            prep_duration       = CASE WHEN v_patch ? 'prep_duration'       THEN (v_patch->>'prep_duration')::interval     ELSE prep_duration       END,
            flexibility         = CASE WHEN v_patch ? 'flexibility'         THEN v_patch->>'flexibility'                   ELSE flexibility         END,
            confidence          = CASE WHEN v_patch ? 'confidence'          THEN (v_patch->>'confidence')::numeric         ELSE confidence          END,
            source_ref          = CASE WHEN v_patch ? 'source_ref'          THEN v_patch->>'source_ref'                    ELSE source_ref          END,
            updated_at          = now()
          WHERE id = v_commit_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR numeric_value_out_of_range THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'commitment';
        v_event_type := 'trip.commitment_updated';
        v_result := jsonb_build_object('id', v_commit_id);

      WHEN 'REMOVE_COMMITMENT' THEN
        v_commit_id := (v_payload->>'commitment_id')::uuid;
        IF v_commit_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_commitments WHERE id = v_commit_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMITMENT_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'commitment';
        v_event_type := 'trip.commitment_removed';
        v_result := jsonb_build_object('id', v_commit_id);

      WHEN 'ADD_STAGE' THEN$branches$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2765: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 6 THEN
    RAISE EXCEPTION '2765: the transform added % command branches, expected exactly 6', n - branches_before;
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

  FOREACH t IN ARRAY ARRAY['ADD_LEG','UPDATE_LEG','REMOVE_LEG',
                           'ADD_COMMITMENT','UPDATE_COMMITMENT','REMOVE_COMMITMENT',
                           'trip.leg_added','trip.leg_updated','trip.leg_removed',
                           'trip.commitment_added','trip.commitment_updated','trip.commitment_removed',
                           'TRIP_LEG_NOT_FOUND','TRIP_COMMITMENT_NOT_FOUND'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2765: % missing after apply', t; END IF;
  END LOOP;

  -- Ledger attribution. 2764's first draft filed every stage event under the
  -- plan family because it set v_event_type and not v_family; the harness found
  -- it by executing the command, not by reading the file. These two counts are
  -- why that cannot recur silently here.
  n := (length(d) - length(replace(d, E'v_family     := ''leg'';', ''))) / length(E'v_family     := ''leg'';');
  IF n <> 3 THEN RAISE EXCEPTION '2765: expected 3 leg-family assignments, found %', n; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''commitment'';', ''))) / length(E'v_family     := ''commitment'';');
  IF n <> 3 THEN RAISE EXCEPTION '2765: expected 3 commitment-family assignments, found %', n; END IF;

  -- What this transform did not name, it must not have moved. 2764's family is
  -- checked here too: a transform that damaged the branch it inserted itself
  -- next to would otherwise pass everything above.
  FOREACH t IN ARRAY ARRAY['TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox',
                           'ADD_STAGE','SET_TRIP_COVER','JOIN_VIA_LINK','CREATE_TRIP'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2765: % was lost', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  IF n <> 3 THEN RAISE EXCEPTION '2765: 2764''s 3 stage-family assignments became %', n; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION '2765: expected the 2 pre-existing trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
