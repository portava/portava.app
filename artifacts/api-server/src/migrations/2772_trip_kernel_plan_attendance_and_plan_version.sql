-- 2772_trip_kernel_plan_attendance_and_plan_version.sql
--
-- Two things, both about the plan aggregate:
--
-- 1. THE ATTENDANCE FAMILY — JOIN_PLAN / LEAVE_PLAN / SET_PLAN_ATTENDANCE,
--    giving `trip_plan_participants` (2771) the writer census-trips TR83 needs.
--    JOIN_PLAN and LEAVE_PLAN are §4.1's own command names.
--
-- 2. THE PLAN COLUMNS AND PLAN-LEVEL VERSION — ADD_PLAN and UPDATE_PLAN learn
--    2770's `stage_id`, `place_id`, `privacy_scope` and `plan_scope`, and every
--    write that changes a plan bumps `trip_plan_items.version`. UPDATE_PLAN
--    accepts an optional `expected_plan_version` and refuses
--    TRIP_PLAN_VERSION_CONFLICT.
--
-- WHY THE PLAN VERSION IS NOT THE TRIP VERSION
-- ============================================
-- The kernel already has optimistic concurrency, on `trips.version`, and §18.3
-- asks for it. But that version moves on EVERY command in the trip: two crew
-- editing two different plans conflict on it, and neither is editing what the
-- other changed. §5.1 gives `trip_plans` its own `version` for exactly this,
-- and 2770 added the column. This migration is what makes it move.
--
-- Both versions are checked when both are supplied. The trip version still
-- guards the aggregate; the plan version guards the row. A client that sends
-- neither gets today's behaviour unchanged.
--
-- WHY LEAVING IS A TRANSITION AND NOT A DELETE
-- ============================================
-- §9.1's attendance vocabulary contains `LEFT`. A state that exists in the
-- vocabulary and can never be reached is not a vocabulary. "Who was going and
-- is not any more" is a fact the downstream transport, reservation,
-- meeting-point and budget calculations §9.1 names actually need, and a deleted
-- row cannot express it. LEAVE_PLAN therefore sets `left` — except where the
-- actor never went beyond `interested`, where there is nothing to remember and
-- the row is removed.
--
-- WHY ATTENDANCE IS SELF-ONLY
-- ===========================
-- None of the three commands accepts a `user_id`. The actor writes their own
-- attendance and there is no way to spell "mark someone else as going", so
-- there is no rule to enforce about it and no way to get that rule wrong. This
-- is the same shape as SET_PRESENCE (2768) and for the same reason: attendance
-- is a statement a person makes about themselves.
--
-- BASE: the post-2769 kernel and 2770 + 2771's schema. Asserted before anything
-- is touched — a kernel that dispatched JOIN_PLAN at a missing table would fail
-- at the first call rather than at apply time.
--
-- Rehearsed on db/harness/run.sh.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2772 (Trips).

BEGIN;

DO $base$
DECLARE d text; t text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2772: trip_kernel_execute not found'; END IF;
  FOREACH t IN ARRAY ARRAY['SET_TRIP_COVER','ADD_STAGE','ADD_LEG','ADD_GOAL',
                           'SET_PRESENCE','TRIP_ROLE_GRANT_REQUIRES_OWNER'] LOOP
    IF position(t in d) = 0 THEN
      RAISE EXCEPTION '2772: the installed kernel is missing %; apply the ancestry, 2764-2766, 2768 and 2769 first', t;
    END IF;
  END LOOP;

  IF to_regclass('public.trip_plan_participants') IS NULL THEN
    RAISE EXCEPTION '2772: requires 2771 (trip_plan_participants). A kernel that dispatches JOIN_PLAN at a missing table fails at the first call, not here.';
  END IF;
  FOREACH t IN ARRAY ARRAY['stage_id','place_id','privacy_scope','plan_scope','version'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_plan_items'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION '2772: requires 2770 — trip_plan_items has no % column', t; END IF;
  END LOOP;
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

  IF position('JOIN_PLAN' in d) > 0 THEN
    RAISE EXCEPTION '2772: the attendance family is already present; this migration is not idempotent by design';
  END IF;

  -- 1. the two new locals
  n := (length(d) - length(replace(d, '  v_outcome_id uuid;', ''))) / length('  v_outcome_id uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor v_outcome_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_outcome_id uuid;',
                  '  v_outcome_id uuid;'            || E'\n' ||
                  '  v_attendance text;'            || E'\n' ||
                  '  v_plan_version bigint;'        || E'\n' ||
                  '  v_expected_plan bigint;');

  -- 2. capability dispatch. Crew throughout: attendance is a statement a crew
  --    member makes about themselves, and a non-member has nothing to attend.
  n := (length(d) - length(replace(d, $a$    WHEN 'SET_PRESENCE' THEN 'crew'$a$, ''))) / length($a$    WHEN 'SET_PRESENCE' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor SET_PRESENCE dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'SET_PRESENCE' THEN 'crew'$a$,
                  $a$    WHEN 'JOIN_PLAN' THEN 'crew' WHEN 'LEAVE_PLAN' THEN 'crew' WHEN 'SET_PLAN_ATTENDANCE' THEN 'crew'
    WHEN 'SET_PRESENCE' THEN 'crew'$a$);

  -- 3. the branches, before the presence family
  n := (length(d) - length(replace(d, E'      WHEN ''SET_PRESENCE'' THEN', ''))) / length(E'      WHEN ''SET_PRESENCE'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor SET_PRESENCE branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''SET_PRESENCE'' THEN', $branches$      WHEN 'JOIN_PLAN' THEN
        -- §4.1's own command name. The actor joins THEIR OWN attendance; there
        -- is no payload user_id, so there is no way to spell "mark someone else
        -- as going" and therefore no rule to enforce about it.
        v_item_id := (v_payload->>'plan_id')::uuid;
        IF v_item_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'plan_id is required', 'contract_version', 2);
        END IF;
        v_attendance := coalesce(v_payload->>'attendance_state', 'going');
        PERFORM 1 FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_plan_participants (plan_id, user_id, attendance_state, role)
          VALUES (v_item_id, v_actor, v_attendance, v_payload->>'role')
          ON CONFLICT (plan_id, user_id) DO UPDATE SET
            attendance_state = EXCLUDED.attendance_state,
            role             = coalesce(EXCLUDED.role, public.trip_plan_participants.role),
            updated_at       = now();
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'attendance';
        v_event_type := 'trip.plan_joined';
        v_result := jsonb_build_object('plan_id', v_item_id, 'user_id', v_actor, 'attendance_state', v_attendance);

      WHEN 'SET_PLAN_ATTENDANCE' THEN
        -- The same relation, said explicitly. JOIN_PLAN defaults to 'going';
        -- this exists so 'maybe' and 'cant_go' are not spelled as a join.
        v_item_id    := (v_payload->>'plan_id')::uuid;
        v_attendance := v_payload->>'attendance_state';
        IF v_item_id IS NULL OR v_attendance IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'plan_id and attendance_state are required', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_plan_participants
         WHERE plan_id = v_item_id AND user_id = v_actor FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_ATTENDANCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_plan_participants
             SET attendance_state = v_attendance,
                 role = CASE WHEN v_payload ? 'role' THEN v_payload->>'role' ELSE role END,
                 updated_at = now()
           WHERE plan_id = v_item_id AND user_id = v_actor;
        EXCEPTION WHEN check_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'attendance';
        v_event_type := 'trip.plan_attendance_set';
        v_result := jsonb_build_object('plan_id', v_item_id, 'user_id', v_actor, 'attendance_state', v_attendance);

      WHEN 'LEAVE_PLAN' THEN
        -- §9.1 has a 'left' state, so leaving is a TRANSITION and not a delete:
        -- "who was going and is not any more" is a fact transport, reservation
        -- and budget calculations need, and a deleted row cannot express it.
        -- The row is removed only when the actor was never anything but
        -- interested, where there is nothing to remember.
        v_item_id := (v_payload->>'plan_id')::uuid;
        IF v_item_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'plan_id is required', 'contract_version', 2);
        END IF;
        SELECT attendance_state INTO v_attendance FROM public.trip_plan_participants
         WHERE plan_id = v_item_id AND user_id = v_actor FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_ATTENDANCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_attendance = 'interested' THEN
          DELETE FROM public.trip_plan_participants
           WHERE plan_id = v_item_id AND user_id = v_actor;
        ELSE
          UPDATE public.trip_plan_participants
             SET attendance_state = 'left', updated_at = now()
           WHERE plan_id = v_item_id AND user_id = v_actor;
        END IF;
        v_family     := 'attendance';
        v_event_type := 'trip.plan_left';
        v_result := jsonb_build_object('plan_id', v_item_id, 'user_id', v_actor,
                                       'attendance_state', CASE WHEN v_attendance = 'interested' THEN NULL ELSE 'left' END,
                                       'row_removed', v_attendance = 'interested');

      WHEN 'SET_PRESENCE' THEN$branches$);

  -- 4. ADD_PLAN learns 2770's four columns. The column list and the VALUES
  --    list are separate anchors, so each is asserted exactly-once and a change
  --    to either that did not land is a raise rather than a syntax error.
  n := (length(d) - length(replace(d, $a$          added_by, description, city, country)$a$, ''))) /
       length($a$          added_by, description, city, country)$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor ADD_PLAN column list occurs % times, expected 1', n; END IF;
  d := replace(d, $a$          added_by, description, city, country)$a$,
                  $a$          added_by, description, city, country,
          stage_id, place_id, privacy_scope, plan_scope)$a$);

  n := (length(d) - length(replace(d, $a$          v_payload->>'country')
        RETURNING * INTO v_row;$a$, ''))) /
       length($a$          v_payload->>'country')
        RETURNING * INTO v_row;$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor ADD_PLAN values tail occurs % times, expected 1', n; END IF;
  d := replace(d, $a$          v_payload->>'country')
        RETURNING * INTO v_row;$a$,
                  $a$          v_payload->>'country',
          -- 2772 / 2770. A stage named here must be THIS trip's; the foreign
          -- key would accept another trip's, exactly as it would have for a leg
          -- (2765). Checked above, before the write.
          (v_payload->>'stage_id')::uuid,
          (v_payload->>'place_id')::uuid,
          coalesce(v_payload->>'privacy_scope', 'crew'),
          coalesce(v_payload->>'plan_scope', 'all_crew'))
        RETURNING * INTO v_row;$a$);

  -- The stage-ownership check, before ADD_PLAN's insert.
  n := (length(d) - length(replace(d, $a$        INSERT INTO public.trip_plan_items ($a$, ''))) /
       length($a$        INSERT INTO public.trip_plan_items ($a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor ADD_PLAN insert occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        INSERT INTO public.trip_plan_items ($a$,
                  $a$        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        INSERT INTO public.trip_plan_items ($a$);

  -- 5. ADD_PLAN's `visibility` becomes DERIVED from privacy_scope, so 2770's
  --    trip_plan_items_visibility_agrees_with_scope holds by construction
  --    rather than by the caller remembering to send both.
  n := (length(d) - length(replace(d, $a$          coalesce(v_payload->>'visibility', 'members'),$a$, ''))) /
       length($a$          coalesce(v_payload->>'visibility', 'members'),$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor ADD_PLAN visibility occurs % times, expected 1', n; END IF;
  d := replace(d, $a$          coalesce(v_payload->>'visibility', 'members'),$a$,
                  $a$          CASE WHEN coalesce(v_payload->>'privacy_scope', 'crew') = 'public'
                    THEN 'public' ELSE 'members' END,$a$);

  -- 6. UPDATE_PLAN reads the plan's own version and refuses a stale one.
  n := (length(d) - length(replace(d, $a$        SELECT status INTO v_status FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;$a$, ''))) /
       length($a$        SELECT status INTO v_status FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor UPDATE_PLAN select occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        SELECT status INTO v_status FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;$a$,
                  $a$        SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;$a$);

  n := (length(d) - length(replace(d, $a$        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';$a$, ''))) /
       length($a$        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor UPDATE_PLAN status guard occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';$a$,
                  $a$        -- 2772 / §5.1 trip_plans.version. PLAN-level optimistic concurrency:
        -- trips.version moves on every command in the trip, so two crew editing
        -- two different plans conflict on it while editing nothing in common.
        -- Both checks apply when both are supplied.
        BEGIN
          v_expected_plan := (v_payload->>'expected_plan_version')::bigint;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'expected_plan_version must be an integer', 'contract_version', 2);
        END;
        IF v_expected_plan IS NOT NULL AND v_expected_plan <> v_plan_version THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_VERSION_CONFLICT',
            'current_version', v_plan_version, 'expected_version', v_expected_plan, 'contract_version', 2);
        END IF;
        IF v_patch ? 'stage_id' AND (v_patch->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_patch->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';$a$);

  -- 7. UPDATE_PLAN's SET list gains the four columns and bumps the plan version.
  --    `visibility` is derived from privacy_scope here too, whether the patch
  --    names the scope or leaves it alone.
  n := (length(d) - length(replace(d, $a$          updated_at          = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_item_id
        RETURNING * INTO v_row;$a$, ''))) /
       length($a$          updated_at          = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_item_id
        RETURNING * INTO v_row;$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor UPDATE_PLAN set tail occurs % times, expected 1', n; END IF;
  d := replace(d, $a$          updated_at          = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_item_id
        RETURNING * INTO v_row;$a$,
                  $a$          stage_id            = CASE WHEN v_patch ? 'stage_id'            THEN (v_patch->>'stage_id')::uuid        ELSE stage_id      END,
          place_id            = CASE WHEN v_patch ? 'place_id'            THEN (v_patch->>'place_id')::uuid        ELSE place_id      END,
          privacy_scope       = CASE WHEN v_patch ? 'privacy_scope'       THEN v_patch->>'privacy_scope'           ELSE privacy_scope END,
          plan_scope          = CASE WHEN v_patch ? 'plan_scope'          THEN v_patch->>'plan_scope'              ELSE plan_scope    END,
          -- Derived, never patched directly, so 2770's tie holds however the
          -- caller spells the change.
          visibility          = CASE WHEN (CASE WHEN v_patch ? 'privacy_scope' THEN v_patch->>'privacy_scope' ELSE privacy_scope END) = 'public'
                                     THEN 'public' ELSE 'members' END,
          version             = version + 1,
          updated_at          = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_item_id
        RETURNING * INTO v_row;$a$);

  -- The old `visibility` patch line must be gone: two SET clauses for one
  -- column is a syntax error, and one that survived would silently win.
  IF position($a$          visibility          = CASE WHEN v_patch ? 'visibility'$a$ in d) > 0 THEN
    RAISE EXCEPTION '2772: UPDATE_PLAN still patches visibility directly; it must be derived';
  END IF;

  -- 8. ADD_PLAN's INSERT gains a subtransaction. 2450's header states the
  --    contract — "Rejections are RETURNED, never RAISED" — and ADD_PLAN had no
  --    handler because none of its columns carried a vocabulary CHECK. 2770 gave
  --    it three, so an unknown privacy_scope now reaches the client as a raw
  --    23514 and a 500 instead of TRIP_COMMAND_MALFORMED. Found by executing it.
  n := (length(d) - length(replace(d, $a$        RETURNING * INTO v_row;
        v_event_type := 'trip.plan_added';$a$, ''))) /
       length($a$        RETURNING * INTO v_row;
        v_event_type := 'trip.plan_added';$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor ADD_PLAN returning occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        INSERT INTO public.trip_plan_items ($a$,
                  $a$        BEGIN
        INSERT INTO public.trip_plan_items ($a$);
  d := replace(d, $a$        RETURNING * INTO v_row;
        v_event_type := 'trip.plan_added';$a$,
                  $a$        RETURNING * INTO v_row;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_event_type := 'trip.plan_added';$a$);

  -- 9. UPDATE_PLAN's UPDATE gains one for the same reason: the same three
  --    vocabularies are patchable.
  n := (length(d) - length(replace(d, $a$        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$, ''))) /
       length($a$        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor UPDATE_PLAN update occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$,
                  $a$        BEGIN
        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'$a$);
  n := (length(d) - length(replace(d, $a$        RETURNING * INTO v_row;
        v_event_type := CASE v_type$a$, ''))) /
       length($a$        RETURNING * INTO v_row;
        v_event_type := CASE v_type$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2772: anchor UPDATE_PLAN returning occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        RETURNING * INTO v_row;
        v_event_type := CASE v_type$a$,
                  $a$        RETURNING * INTO v_row;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_event_type := CASE v_type$a$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2772: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 3 THEN
    RAISE EXCEPTION '2772: the transform added % command branches, expected exactly 3', n - branches_before;
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

  -- Both plan writes must be inside a subtransaction, or a vocabulary CHECK
  -- reaches the client as a raw 23514 instead of a typed refusal. This is the
  -- postcondition for the defect the probe found.
  n := (length(d) - length(replace(d, $chk$        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN$chk$, ''))) /
       length($chk$        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR not_null_violation THEN$chk$);
  IF n <> 2 THEN RAISE EXCEPTION '2772: expected ADD_PLAN and UPDATE_PLAN both wrapped, found % handler(s)', n; END IF;

  FOREACH t IN ARRAY ARRAY['JOIN_PLAN','LEAVE_PLAN','SET_PLAN_ATTENDANCE',
                           'trip.plan_joined','trip.plan_left','trip.plan_attendance_set',
                           'TRIP_PLAN_ATTENDANCE_NOT_FOUND','trip_plan_participants',
                           'privacy_scope','plan_scope','stage_id'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2772: % missing after apply', t; END IF;
  END LOOP;

  n := (length(d) - length(replace(d, 'v_family     := ''attendance'';', ''))) / length('v_family     := ''attendance'';');
  IF n <> 3 THEN RAISE EXCEPTION '2772: expected 3 attendance-family assignments, found %', n; END IF;

  -- None of the three may accept a subject: attendance is self-only, and a
  -- payload user_id reaching the write is how that stops being true.
  IF position($chk$INSERT INTO public.trip_plan_participants (plan_id, user_id, attendance_state, role)
          VALUES (v_item_id, v_actor,$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2772: JOIN_PLAN does not write the ACTOR as the participant';
  END IF;

  -- What this transform did not name, it must not have moved.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','ADD_GOAL','ADD_RISK',
                           'SET_PRESENCE','CREATE_PROPOSAL','RECORD_OUTCOME','SET_TRIP_COVER',
                           'JOIN_VIA_LINK','CREATE_TRIP','REMOVE_PLAN','ADD_PLAN',
                           'TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox','TRIP_ROLE_GRANT_REQUIRES_OWNER'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2772: % was lost', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk','proposal'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2772: the %-family assignments became %', t, n; END IF;
  END LOOP;
END
$post$;

COMMIT;
