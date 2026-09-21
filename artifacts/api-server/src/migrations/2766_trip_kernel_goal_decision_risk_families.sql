-- 2766_trip_kernel_goal_decision_risk_families.sql
--
-- Trips v4 §4: nine commands across three tables —
--   ADD/UPDATE/REMOVE_GOAL           -> trip_goals            (census-trips TR84)
--   ADD/UPDATE/REMOVE_DECISION_TASK  -> trip_decision_tasks   (TR85)
--   ADD/UPDATE/REMOVE_RISK           -> trip_risks            (TR86)
--
-- Third in the §5 sequence, after 2764 (stages) and 2765 (legs, commitments).
-- These three tables are trip-scoped: none of them references a stage, so
-- unlike 2765 there is no stage-ownership check to make. There is one
-- ownership check of a different kind, below.
--
-- BASE: the post-2765 kernel. Asserted before anything is touched.
--
-- NOT REHEARSED ON ANY SUPABASE DATABASE — see
-- docs/architecture/blocker-ledger.md, TRIP_KERNEL_NEVER_DEPLOYED. Rehearsed on
-- db/harness/run.sh, where the commands are executed and the rollback must
-- restore the definition byte-for-byte. That file's header states what a green
-- run does and does not establish; it is worth reading before quoting one.
--
-- THE ONE INVARIANT THAT IS NOT A COLUMN CONSTRAINT
-- =================================================
-- `trip_decision_tasks.assigned_user_id` references `profiles`, so the foreign
-- key proves the person exists and nothing else. A decision task assigned to
-- someone who is not on the trip is a task its assignee cannot see, cannot act
-- on, and will never be told about — a row that looks assigned and is not.
-- ADD_DECISION_TASK and UPDATE_DECISION_TASK therefore require the assignee to
-- be an accepted member, by the same `authz.is_accepted_trip_member` rule that
-- decides who may issue the command, and refuse TRIP_ASSIGNEE_NOT_CREW
-- otherwise. That reason is new and deliberately distinct from
-- TRIP_AUTH_NOT_CREW: the actor is authorised, the assignee is not, and a
-- client that cannot tell those apart will show the wrong error to the wrong
-- person.
--
-- NOT NULL DEFAULT COLUMNS ARE COALESCED, NOT PASSED THROUGH
-- ==========================================================
-- `priority`, `status`, `evidence_json`, `trigger_json` and `mitigation_json`
-- are NOT NULL with defaults. Writing `v_payload->>'status'` directly would
-- send NULL for a payload that simply omitted the key, and the NOT NULL would
-- refuse it as TRIP_COMMAND_MALFORMED — a refusal of a payload that was never
-- malformed. Each is coalesced to the table's own default instead, and the
-- harness probes an omit-everything payload for exactly this reason.

BEGIN;

DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2766: trip_kernel_execute not found'; END IF;
  IF position('SET_TRIP_COVER' in d) = 0 THEN
    RAISE EXCEPTION '2766: the installed kernel predates 2590. Apply 2450 -> 2500 -> 2590 -> 2764 -> 2765 first.';
  END IF;
  IF position('ADD_STAGE' in d) = 0 THEN
    RAISE EXCEPTION '2766: the installed kernel predates 2764 (no stage family).';
  END IF;
  IF position('ADD_LEG' in d) = 0 THEN
    RAISE EXCEPTION '2766: the installed kernel predates 2765 (no leg family).';
  END IF;
  IF position('v_patch      jsonb;' in d) = 0 THEN
    RAISE EXCEPTION '2766: the installed kernel does not declare v_patch; the UPDATE branches below reuse it';
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

  IF position('ADD_GOAL' in d) > 0 OR position('ADD_RISK' in d) > 0
     OR position('ADD_DECISION_TASK' in d) > 0 THEN
    RAISE EXCEPTION '2766: one of these families is already present; this migration is not idempotent by design';
  END IF;

  -- 1. the three new ids
  n := (length(d) - length(replace(d, '  v_commit_id  uuid;', ''))) / length('  v_commit_id  uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2766: anchor v_commit_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_commit_id  uuid;',
                  '  v_commit_id  uuid;' || E'\n' ||
                  '  v_goal_id    uuid;' || E'\n' ||
                  '  v_task_id    uuid;' || E'\n' ||
                  '  v_risk_id    uuid;');

  -- 2. capability dispatch. Crew throughout: a goal, a decision task and a risk
  --    are trip state, and the 2337 accepted-member rule guards trip state.
  n := (length(d) - length(replace(d, $a$    WHEN 'ADD_LEG' THEN 'crew'$a$, ''))) / length($a$    WHEN 'ADD_LEG' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2766: anchor ADD_LEG dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_LEG' THEN 'crew'$a$,
                  $a$    WHEN 'ADD_GOAL' THEN 'crew' WHEN 'UPDATE_GOAL' THEN 'crew' WHEN 'REMOVE_GOAL' THEN 'crew'
    WHEN 'ADD_DECISION_TASK' THEN 'crew' WHEN 'UPDATE_DECISION_TASK' THEN 'crew' WHEN 'REMOVE_DECISION_TASK' THEN 'crew'
    WHEN 'ADD_RISK' THEN 'crew' WHEN 'UPDATE_RISK' THEN 'crew' WHEN 'REMOVE_RISK' THEN 'crew'
    WHEN 'ADD_LEG' THEN 'crew'$a$);

  -- 3. the branches, inserted before the leg family
  n := (length(d) - length(replace(d, E'      WHEN ''ADD_LEG'' THEN', ''))) / length(E'      WHEN ''ADD_LEG'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2766: anchor ADD_LEG branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''ADD_LEG'' THEN', $branches$      WHEN 'ADD_GOAL' THEN
        IF coalesce(v_payload->>'type','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'type required', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_goals (trip_id, type, priority, status, evidence_json)
          VALUES (v_trip_id, (v_payload->>'type'),
                  coalesce((v_payload->>'priority'), 'normal'),
                  coalesce((v_payload->>'status'), 'open'),
                  coalesce((v_payload->'evidence_json'), '{}'::jsonb))
          RETURNING id INTO v_goal_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'goal';
        v_event_type := 'trip.goal_added';
        v_result := jsonb_build_object('id', v_goal_id);

      WHEN 'UPDATE_GOAL' THEN
        v_goal_id := (v_payload->>'goal_id')::uuid;
        v_patch   := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_goal_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_GOAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_goals SET
            type          = CASE WHEN v_patch ? 'type' THEN (v_patch->>'type') ELSE type END,
            priority      = CASE WHEN v_patch ? 'priority' THEN coalesce((v_patch->>'priority'), 'normal') ELSE priority END,
            status        = CASE WHEN v_patch ? 'status' THEN coalesce((v_patch->>'status'), 'open') ELSE status END,
            evidence_json = CASE WHEN v_patch ? 'evidence_json' THEN coalesce((v_patch->'evidence_json'), '{}'::jsonb) ELSE evidence_json END,
            updated_at = now()
          WHERE id = v_goal_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'goal';
        v_event_type := 'trip.goal_updated';
        v_result := jsonb_build_object('id', v_goal_id);

      WHEN 'REMOVE_GOAL' THEN
        v_goal_id := (v_payload->>'goal_id')::uuid;
        IF v_goal_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_GOAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'goal';
        v_event_type := 'trip.goal_removed';
        v_result := jsonb_build_object('id', v_goal_id);

      WHEN 'ADD_DECISION_TASK' THEN
        IF coalesce(v_payload->>'type','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'type required', 'contract_version', 2);
        END IF;
        -- An assignee who is not crew cannot see the trip, let alone do the task.
        -- The foreign key only proves the profile exists.
        IF (v_payload->>'assigned_user_id') IS NOT NULL
           AND NOT authz.is_accepted_trip_member(v_trip_id, (v_payload->>'assigned_user_id')::uuid) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_ASSIGNEE_NOT_CREW', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_decision_tasks (trip_id, type, deadline_at, consequence, assigned_user_id, status)
          VALUES (v_trip_id, (v_payload->>'type'),
                  (v_payload->>'deadline_at')::timestamptz,
                  (v_payload->>'consequence'),
                  (v_payload->>'assigned_user_id')::uuid,
                  coalesce((v_payload->>'status'), 'pending'))
          RETURNING id INTO v_task_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'decision_task';
        v_event_type := 'trip.decision_task_added';
        v_result := jsonb_build_object('id', v_task_id);

      WHEN 'UPDATE_DECISION_TASK' THEN
        v_task_id := (v_payload->>'task_id')::uuid;
        v_patch   := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_task_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_decision_tasks WHERE id = v_task_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_DECISION_TASK_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_patch ? 'assigned_user_id' AND (v_patch->>'assigned_user_id') IS NOT NULL
           AND NOT authz.is_accepted_trip_member(v_trip_id, (v_patch->>'assigned_user_id')::uuid) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_ASSIGNEE_NOT_CREW', 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_decision_tasks SET
            type             = CASE WHEN v_patch ? 'type' THEN (v_patch->>'type') ELSE type END,
            deadline_at      = CASE WHEN v_patch ? 'deadline_at' THEN (v_patch->>'deadline_at')::timestamptz ELSE deadline_at END,
            consequence      = CASE WHEN v_patch ? 'consequence' THEN (v_patch->>'consequence') ELSE consequence END,
            assigned_user_id = CASE WHEN v_patch ? 'assigned_user_id' THEN (v_patch->>'assigned_user_id')::uuid ELSE assigned_user_id END,
            status           = CASE WHEN v_patch ? 'status' THEN coalesce((v_patch->>'status'), 'pending') ELSE status END,
            updated_at = now()
          WHERE id = v_task_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'decision_task';
        v_event_type := 'trip.decision_task_updated';
        v_result := jsonb_build_object('id', v_task_id);

      WHEN 'REMOVE_DECISION_TASK' THEN
        v_task_id := (v_payload->>'task_id')::uuid;
        IF v_task_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_decision_tasks WHERE id = v_task_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_DECISION_TASK_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'decision_task';
        v_event_type := 'trip.decision_task_removed';
        v_result := jsonb_build_object('id', v_task_id);

      WHEN 'ADD_RISK' THEN
        IF coalesce(v_payload->>'likelihood','') = ''
           OR coalesce(v_payload->>'impact','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'likelihood and impact required', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_risks (trip_id, likelihood, impact, trigger_json, mitigation_json, status)
          VALUES (v_trip_id, (v_payload->>'likelihood'),
                  (v_payload->>'impact'),
                  coalesce((v_payload->'trigger_json'), '{}'::jsonb),
                  coalesce((v_payload->'mitigation_json'), '{}'::jsonb),
                  coalesce((v_payload->>'status'), 'open'))
          RETURNING id INTO v_risk_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'risk';
        v_event_type := 'trip.risk_added';
        v_result := jsonb_build_object('id', v_risk_id);

      WHEN 'UPDATE_RISK' THEN
        v_risk_id := (v_payload->>'risk_id')::uuid;
        v_patch   := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_risk_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_risks WHERE id = v_risk_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RISK_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_risks SET
            likelihood      = CASE WHEN v_patch ? 'likelihood' THEN (v_patch->>'likelihood') ELSE likelihood END,
            impact          = CASE WHEN v_patch ? 'impact' THEN (v_patch->>'impact') ELSE impact END,
            trigger_json    = CASE WHEN v_patch ? 'trigger_json' THEN coalesce((v_patch->'trigger_json'), '{}'::jsonb) ELSE trigger_json END,
            mitigation_json = CASE WHEN v_patch ? 'mitigation_json' THEN coalesce((v_patch->'mitigation_json'), '{}'::jsonb) ELSE mitigation_json END,
            status          = CASE WHEN v_patch ? 'status' THEN coalesce((v_patch->>'status'), 'open') ELSE status END,
            updated_at = now()
          WHERE id = v_risk_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'risk';
        v_event_type := 'trip.risk_updated';
        v_result := jsonb_build_object('id', v_risk_id);

      WHEN 'REMOVE_RISK' THEN
        v_risk_id := (v_payload->>'risk_id')::uuid;
        IF v_risk_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_risks WHERE id = v_risk_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RISK_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'risk';
        v_event_type := 'trip.risk_removed';
        v_result := jsonb_build_object('id', v_risk_id);
      WHEN 'ADD_LEG' THEN$branches$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2766: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 9 THEN
    RAISE EXCEPTION '2766: the transform added % command branches, expected exactly 9', n - branches_before;
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

  FOREACH t IN ARRAY ARRAY['ADD_GOAL','UPDATE_GOAL','REMOVE_GOAL',
                           'ADD_DECISION_TASK','UPDATE_DECISION_TASK','REMOVE_DECISION_TASK',
                           'ADD_RISK','UPDATE_RISK','REMOVE_RISK',
                           'trip.goal_added','trip.goal_updated','trip.goal_removed',
                           'trip.decision_task_added','trip.decision_task_updated','trip.decision_task_removed',
                           'trip.risk_added','trip.risk_updated','trip.risk_removed',
                           'TRIP_GOAL_NOT_FOUND','TRIP_DECISION_TASK_NOT_FOUND','TRIP_RISK_NOT_FOUND',
                           'TRIP_ASSIGNEE_NOT_CREW'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2766: % missing after apply', t; END IF;
  END LOOP;

  -- Ledger attribution, per family. 2764's first draft filed every stage event
  -- under 'plan' because it set v_event_type and not v_family; the harness found
  -- it by executing the command. These counts are why it cannot recur silently.
  FOREACH t IN ARRAY ARRAY['goal','decision_task','risk'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2766: expected 3 %-family assignments, found %', t, n; END IF;
  END LOOP;

  -- What this transform did not name, it must not have moved.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','SET_TRIP_COVER',
                           'JOIN_VIA_LINK','CREATE_TRIP','REMOVE_PLAN',
                           'TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2766: % was lost', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2766: the earlier %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION '2766: expected the 2 pre-existing trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
