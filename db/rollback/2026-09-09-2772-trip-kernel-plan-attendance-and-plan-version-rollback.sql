-- Rollback for 2772_trip_kernel_plan_attendance_and_plan_version.sql
--
-- Removes the attendance family and returns ADD_PLAN / UPDATE_PLAN to the shape
-- 2769 left them in: no stage_id, place_id, privacy_scope or plan_scope on the
-- write path, no plan-level version bump, no expected_plan_version check, and
-- no subtransaction around either plan write.
--
-- READ THAT LAST ONE. Removing the subtransactions puts back a kernel in which
-- an unknown privacy_scope reaches the caller as a raw 23514 rather than
-- TRIP_COMMAND_MALFORMED — but only if 2770's columns are still there. Run the
-- 2770 rollback as well, or run neither; a kernel without this file and a table
-- with 2770's CHECKs is the one combination that is worse than either end
-- state, and the postcondition below says so rather than leaving it to be
-- discovered.
--
-- ORDER: before the 2771 rollback (which refuses while the kernel still names
-- trip_plan_participants) and before 2769's.
--
-- DATA: none. Attendance rows survive; the writer is what is removed.
--
-- Rehearsed on db/harness/run.sh, which fails unless the restored definition is
-- byte-identical to the one captured before 2772.

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2772: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('JOIN_PLAN' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2772: the attendance family is not present; 2772 was never applied here';
  END IF;
  IF position('SET_PRESENCE' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2772: the presence family is gone, so the excision has no terminator. The 2768 rollback was run first; that ordering is wrong.';
  END IF;

  -- 9/8. The two subtransactions, innermost first.
  d := replace(d, $a$        RETURNING * INTO v_row;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_event_type := CASE v_type$a$,
                  $a$        RETURNING * INTO v_row;
        v_event_type := CASE v_type$a$);
  d := replace(d, $a$        BEGIN
        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$,
                  $a$        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$);
  d := replace(d, $a$        RETURNING * INTO v_row;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_event_type := 'trip.plan_added';$a$,
                  $a$        RETURNING * INTO v_row;
        v_event_type := 'trip.plan_added';$a$);
  d := replace(d, $a$        BEGIN
        INSERT INTO public.trip_plan_items ($a$,
                  $a$        INSERT INTO public.trip_plan_items ($a$);
  IF position('EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2772: a plan subtransaction survived';
  END IF;

  -- 7. UPDATE_PLAN's SET list.
  d := replace(d, $a$          stage_id            = CASE WHEN v_patch ? 'stage_id'            THEN (v_patch->>'stage_id')::uuid        ELSE stage_id      END,
          place_id            = CASE WHEN v_patch ? 'place_id'            THEN (v_patch->>'place_id')::uuid        ELSE place_id      END,
          privacy_scope       = CASE WHEN v_patch ? 'privacy_scope'       THEN v_patch->>'privacy_scope'           ELSE privacy_scope END,
          plan_scope          = CASE WHEN v_patch ? 'plan_scope'          THEN v_patch->>'plan_scope'              ELSE plan_scope    END,
          -- Derived, never patched directly, so 2770's tie holds however the
          -- caller spells the change.
          visibility          = CASE WHEN (CASE WHEN v_patch ? 'privacy_scope' THEN v_patch->>'privacy_scope' ELSE privacy_scope END) = 'public'
                                     THEN 'public' ELSE 'members' END,
          version             = version + 1,
          updated_at$a$,
                  $a$          updated_at$a$);

  -- 6. The plan-version check and the patch's stage-ownership check.
  d := regexp_replace(d,
       $a$        -- 2772 / §5\.1 trip_plans\.version\..*?        IF v_patch \? 'status' THEN$a$,
       $a$        IF v_patch ? 'status' THEN$a$,
       '');
  d := replace(d, $a$        SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items$a$,
                  $a$        SELECT status INTO v_status FROM public.trip_plan_items$a$);

  -- 5/4. ADD_PLAN's derived visibility, its four values, its column list and
  --      its stage-ownership check.
  d := replace(d, $a$          CASE WHEN coalesce(v_payload->>'privacy_scope', 'crew') = 'public'
                    THEN 'public' ELSE 'members' END,$a$,
                  $a$          coalesce(v_payload->>'visibility', 'members'),$a$);
  d := regexp_replace(d,
       $a$          v_payload->>'country',\n(          --[^\n]*\n)*          \(v_payload->>'stage_id'\)::uuid,\n          \(v_payload->>'place_id'\)::uuid,\n          coalesce\(v_payload->>'privacy_scope', 'crew'\),\n          coalesce\(v_payload->>'plan_scope', 'all_crew'\)\)$a$,
       $a$          v_payload->>'country')$a$,
       '');
  d := replace(d, $a$          added_by, description, city, country,
          stage_id, place_id, privacy_scope, plan_scope)$a$,
                  $a$          added_by, description, city, country)$a$);
  d := replace(d, $a$        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        INSERT INTO public.trip_plan_items ($a$,
                  $a$        INSERT INTO public.trip_plan_items ($a$);

  -- 3. The three branches.
  d := regexp_replace(d,
       $a$      WHEN 'JOIN_PLAN' THEN.*?      WHEN 'SET_PRESENCE' THEN$a$,
       $a$      WHEN 'SET_PRESENCE' THEN$a$,
       '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 3 THEN
    RAISE EXCEPTION 'rollback 2772: the excision removed % command branches, expected exactly 3', branches_before - n;
  END IF;

  -- 2. The dispatch.
  d := replace(d, $a$    WHEN 'JOIN_PLAN' THEN 'crew' WHEN 'LEAVE_PLAN' THEN 'crew' WHEN 'SET_PLAN_ATTENDANCE' THEN 'crew'
$a$, '');

  -- 1. The declarations.
  d := replace(d, E'  v_attendance text;\n', '');
  d := replace(d, E'  v_plan_version bigint;\n', '');
  d := replace(d, E'  v_expected_plan bigint;\n', '');

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2772: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['JOIN_PLAN','LEAVE_PLAN','SET_PLAN_ATTENDANCE','trip_plan_participants',
                           'v_attendance','v_plan_version','v_expected_plan',
                           'trip.plan_joined','trip.plan_left','trip.plan_attendance_set',
                           'TRIP_PLAN_ATTENDANCE_NOT_FOUND','TRIP_PLAN_VERSION_CONFLICT',
                           'privacy_scope','plan_scope'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2772: % survived', t; END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['ADD_PLAN','UPDATE_PLAN','ADD_STAGE','ADD_LEG','ADD_GOAL',
                           'SET_PRESENCE','CREATE_PROPOSAL','RECORD_OUTCOME','SET_TRIP_COVER',
                           'JOIN_VIA_LINK','CREATE_TRIP','TRIP_VERSION_CONFLICT',
                           'TRIP_ROLE_GRANT_REQUIRES_OWNER','trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2772: % lost — the excision overran', t; END IF;
  END LOOP;

  -- The combination this file's header warns about: a kernel that no longer
  -- guards the vocabularies, and a table that still enforces them.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid='public.trip_plan_items'::regclass
                AND attname='privacy_scope' AND NOT attisdropped) THEN
    RAISE WARNING 'rollback 2772: trip_plan_items still carries 2770''s columns and CHECKs, and the kernel no longer wraps its plan writes. An unknown privacy_scope now reaches the caller as a raw 23514. Run the 2770 rollback too.';
  END IF;
END
$post$;

COMMIT;
