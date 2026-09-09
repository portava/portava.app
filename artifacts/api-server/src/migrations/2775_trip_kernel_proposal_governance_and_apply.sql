-- 2775_trip_kernel_proposal_governance_and_apply.sql
--
-- The kernel half of §9.3, in three parts:
--
-- 1. VOTE_ON_PROPOSAL, so MAJORITY and UNANIMOUS have something to count.
-- 2. ACCEPT_PROPOSAL / REJECT_PROPOSAL gated by the proposal's OWN
--    decision_rule (2774) instead of unconditional `host`, which 2768 shipped
--    as an explicitly interim choice.
-- 3. An accepted proposal that ACTUALLY MUTATES canonical state, instead of
--    flipping a status column and leaving the change to somebody else.
--
-- WHY (3) IS THE POINT
-- ====================
-- 2768's ACCEPT_PROPOSAL set status='accepted' and stopped. A proposal system
-- whose acceptance changes nothing is a voting UI, not governance: the plan
-- still has to be edited by hand afterwards, by someone, through some other
-- path, and §9.3's "Compass may create a proposal, but cannot silently mutate
-- other participants' commitments" becomes meaningless — the mutation happens
-- anyway, just untraceably.
--
-- So acceptance APPLIES the proposal, in the same transaction, through the same
-- kernel, emitting BOTH events: trip.proposal_accepted and whatever the applied
-- change emits. One command, one version bump, two events would break the
-- one-event-per-version invariant 2420 relies on — so the applied change is
-- carried in the acceptance event's payload under `applied`, and the canonical
-- write is done directly. The alternative, recursing into trip_kernel_execute,
-- would take the aggregate lock twice and deadlock against itself.
--
-- WHAT CAN BE APPLIED, AND WHAT REFUSES
-- =====================================
-- 2763's proposal_type vocabulary is add_plan | move_plan | cancel_plan |
-- add_commitment | stage_change | other. Three of those have an unambiguous
-- canonical effect and are applied:
--
--   add_plan        insert a trip_plan_items row from payload_json.plan
--   move_plan       patch starts_at / ends_at / day_date on a named plan
--   cancel_plan     set that plan's status to 'cancelled'
--
-- `add_commitment`, `stage_change` and `other` are ACCEPTED but NOT APPLIED,
-- and the acceptance says so: `applied: {"status": "NOT_APPLICABLE", "reason":
-- "PROPOSAL_TYPE_HAS_NO_CANONICAL_EFFECT"}`. Inventing an effect for `other`
-- would be inventing product behaviour from a vocabulary entry, and
-- `stage_change` has no payload shape anywhere in the spec to apply. Saying so
-- in the event is what keeps "accepted" from being read as "done".
--
-- A proposal whose payload is malformed for its own type is REFUSED with
-- TRIP_PROPOSAL_PAYLOAD_INVALID and stays pending. Accepting a proposal that
-- cannot be carried out would record a decision that never took effect.
--
-- BASE: the post-2772 kernel and 2774's schema.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2775 (Trips).

BEGIN;

DO $base$
DECLARE d text; t text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2775: trip_kernel_execute not found'; END IF;
  FOREACH t IN ARRAY ARRAY['ACCEPT_PROPOSAL','JOIN_PLAN','SET_PRESENCE','ADD_STAGE'] LOOP
    IF position(t in d) = 0 THEN
      RAISE EXCEPTION '2775: the installed kernel is missing %; apply the ancestry and 2764-2772 first', t;
    END IF;
  END LOOP;
  IF to_regclass('public.trip_proposal_votes') IS NULL THEN
    RAISE EXCEPTION '2775: requires 2774 (trip_proposal_votes)';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_proposals'::regclass AND attname='decision_rule' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION '2775: requires 2774 — trip_proposals has no decision_rule'; END IF;
  IF to_regprocedure('public.trip_proposal_tally(uuid)') IS NULL THEN
    RAISE EXCEPTION '2775: requires 2774 — trip_proposal_tally is absent';
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

  IF position('VOTE_ON_PROPOSAL' in d) > 0 THEN
    RAISE EXCEPTION '2775: already applied; this migration is not idempotent by design';
  END IF;

  -- 1. locals
  n := (length(d) - length(replace(d, '  v_expected_plan bigint;', ''))) / length('  v_expected_plan bigint;');
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor v_expected_plan occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_expected_plan bigint;',
                  '  v_expected_plan bigint;'   || E'\n' ||
                  '  v_vote text;'              || E'\n' ||
                  '  v_decision_rule text;'     || E'\n' ||
                  '  v_tally jsonb;'            || E'\n' ||
                  '  v_applied jsonb;'          || E'\n' ||
                  '  v_prop_payload jsonb;');

  -- 2. dispatch. VOTE_ON_PROPOSAL is crew — anyone in the electorate may vote.
  --    ACCEPT/REJECT move from 'host' to 'proposal_rule', a capability whose
  --    check reads the proposal's own decision_rule.
  n := (length(d) - length(replace(d, $a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'$a$, ''))) /
       length($a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor proposal dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'$a$,
                  $a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'VOTE_ON_PROPOSAL' THEN 'crew'
    WHEN 'ACCEPT_PROPOSAL' THEN 'proposal_rule' WHEN 'REJECT_PROPOSAL' THEN 'proposal_rule'$a$);

  -- 3. the capability check for 'proposal_rule', added to the CASE that already
  --    handles crew / owner / invited / admin. Placed before the ELSE so the
  --    fall-through for 'system' is untouched.
  n := (length(d) - length(replace(d, $a$      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check
    END CASE;$a$, ''))) /
       length($a$      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check
    END CASE;$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor capability CASE occurs % times, expected 1', n; END IF;
  d := replace(d, $a$      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check
    END CASE;$a$,
                  $a$      WHEN 'proposal_rule' THEN
        -- §9.3. The rule lives on the PROPOSAL, so the capability is resolved
        -- per row rather than per command type. An unknown rule is refused,
        -- fail-closed: the CHECK on decision_rule makes that unreachable
        -- today, and the branch exists so a widened vocabulary cannot
        -- accidentally become permissive.
        v_proposal_id := (v_payload->>'proposal_id')::uuid;
        IF v_proposal_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'proposal_id is required', 'contract_version', 2);
        END IF;
        SELECT decision_rule INTO v_decision_rule FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_decision_rule = 'host' THEN
          IF NOT (v_is_owner OR EXISTS (SELECT 1 FROM public.trip_members m
                                         WHERE m.trip_id = v_trip_id AND m.user_id = v_actor
                                           AND m.role = 'co_host'
                                           AND coalesce(m.status, 'accepted') = 'accepted')) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_HOST', 'contract_version', 2);
          END IF;
        ELSIF v_decision_rule = 'anyone' THEN
          IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW', 'contract_version', 2);
          END IF;
        ELSIF v_decision_rule IN ('majority', 'unanimous') THEN
          -- Crew may close a vote; the VOTE decides, not the closer. The tally
          -- is checked in the branch, so a crew member cannot force an accept
          -- the votes do not support.
          IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW', 'contract_version', 2);
          END IF;
        ELSE
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_RULE_UNKNOWN',
            'decision_rule', v_decision_rule, 'contract_version', 2);
        END IF;
      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check
    END CASE;$a$);

  -- 4. the VOTE_ON_PROPOSAL branch
  n := (length(d) - length(replace(d, E'      WHEN ''CREATE_PROPOSAL'' THEN', ''))) / length(E'      WHEN ''CREATE_PROPOSAL'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor CREATE_PROPOSAL branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''CREATE_PROPOSAL'' THEN', $branches$      WHEN 'VOTE_ON_PROPOSAL' THEN
        -- §9.3. Self-only, like presence and attendance: no user_id key, so
        -- there is no way to spell "vote on someone's behalf".
        v_proposal_id := (v_payload->>'proposal_id')::uuid;
        v_vote        := v_payload->>'vote';
        IF v_proposal_id IS NULL OR v_vote IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'proposal_id and vote are required', 'contract_version', 2);
        END IF;
        SELECT status, decision_rule INTO v_proposal_status, v_decision_rule
          FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        -- A decided proposal does not take more votes. Recording one would
        -- suggest the decision could still change, and it cannot.
        IF v_proposal_status <> 'pending' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_PENDING',
            'status', v_proposal_status, 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_proposal_votes (proposal_id, user_id, vote)
          VALUES (v_proposal_id, v_actor, v_vote)
          ON CONFLICT (proposal_id, user_id) DO UPDATE SET
            vote = EXCLUDED.vote, updated_at = now();
        EXCEPTION WHEN check_violation OR foreign_key_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_tally := public.trip_proposal_tally(v_proposal_id);
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_voted';
        v_result := jsonb_build_object('proposal_id', v_proposal_id, 'user_id', v_actor,
                                       'vote', v_vote, 'tally', v_tally);

      WHEN 'CREATE_PROPOSAL' THEN$branches$);

  -- 5. CREATE_PROPOSAL records the author and the rule.
  n := (length(d) - length(replace(d, $a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version)$a$, ''))) /
       length($a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version)$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor CREATE_PROPOSAL columns occurs % times, expected 1', n; END IF;
  d := replace(d, $a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version)$a$,
                  $a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version,
             proposed_by, decision_rule)$a$);
  n := (length(d) - length(replace(d, $a$                  coalesce((v_payload->>'affected_version')::bigint, v_current))$a$, ''))) /
       length($a$                  coalesce((v_payload->>'affected_version')::bigint, v_current))$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor CREATE_PROPOSAL values occurs % times, expected 1', n; END IF;
  d := replace(d, $a$                  coalesce((v_payload->>'affected_version')::bigint, v_current))$a$,
                  $a$                  coalesce((v_payload->>'affected_version')::bigint, v_current),
                  -- §9.3 proposedBy. Always the ACTOR: a proposal attributed to
                  -- someone else is not their proposal.
                  v_actor,
                  -- Defaults to the narrowest rule, matching the column default.
                  coalesce(v_payload->>'decision_rule', 'host'))$a$);

  -- 6. ACCEPT_PROPOSAL checks the tally and APPLIES the change.
  n := (length(d) - length(replace(d, $a$        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted');$a$, ''))) /
       length($a$        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted');$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2775: anchor ACCEPT_PROPOSAL body occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted');$a$,
                  $a$        -- §9.3. Under a counted rule the VOTE decides, not whoever issued
        -- the command. A crew member may close the vote; they may not
        -- overrule it.
        SELECT decision_rule INTO v_decision_rule FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        IF v_decision_rule IN ('majority', 'unanimous') THEN
          v_tally := public.trip_proposal_tally(v_proposal_id);
          IF NOT coalesce((v_tally->>(v_decision_rule || '_met'))::boolean, false) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_VOTE_NOT_MET',
              'tally', v_tally, 'contract_version', 2);
          END IF;
        END IF;

        -- Apply the proposal to canonical state, in THIS transaction. An
        -- acceptance that changes nothing is a voting UI, not governance.
        SELECT payload_json INTO v_prop_payload FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        SELECT proposal_type INTO v_role FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id;

        IF v_role = 'add_plan' THEN
          IF coalesce(v_prop_payload->'plan'->>'title','') = '' THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_PAYLOAD_INVALID',
              'detail', 'add_plan needs payload_json.plan.title', 'contract_version', 2);
          END IF;
          BEGIN
            INSERT INTO public.trip_plan_items
              (trip_id, creator_id, title, status, starts_at, ends_at, privacy_scope, visibility)
            VALUES (v_trip_id, v_actor, v_prop_payload->'plan'->>'title',
                    coalesce(v_prop_payload->'plan'->>'status','tentative'),
                    (v_prop_payload->'plan'->>'starts_at')::timestamptz,
                    (v_prop_payload->'plan'->>'ends_at')::timestamptz,
                    coalesce(v_prop_payload->'plan'->>'privacy_scope','crew'),
                    CASE WHEN coalesce(v_prop_payload->'plan'->>'privacy_scope','crew') = 'public'
                         THEN 'public' ELSE 'members' END)
            RETURNING id INTO v_item_id;
          EXCEPTION WHEN check_violation OR foreign_key_violation
                      OR invalid_text_representation OR invalid_datetime_format THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_PAYLOAD_INVALID',
              'detail', SQLERRM, 'contract_version', 2);
          END;
          v_applied := jsonb_build_object('status', 'APPLIED', 'effect', 'plan_added', 'plan_id', v_item_id);

        ELSIF v_role IN ('move_plan', 'cancel_plan') THEN
          v_item_id := (v_prop_payload->>'plan_id')::uuid;
          IF v_item_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_PAYLOAD_INVALID',
              'detail', v_role || ' needs payload_json.plan_id', 'contract_version', 2);
          END IF;
          PERFORM 1 FROM public.trip_plan_items
           WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
          END IF;
          BEGIN
            IF v_role = 'cancel_plan' THEN
              UPDATE public.trip_plan_items
                 SET status = 'cancelled', version = version + 1, updated_at = now()
               WHERE id = v_item_id;
              v_applied := jsonb_build_object('status', 'APPLIED', 'effect', 'plan_cancelled', 'plan_id', v_item_id);
            ELSE
              UPDATE public.trip_plan_items SET
                starts_at = CASE WHEN v_prop_payload ? 'starts_at' THEN (v_prop_payload->>'starts_at')::timestamptz ELSE starts_at END,
                ends_at   = CASE WHEN v_prop_payload ? 'ends_at'   THEN (v_prop_payload->>'ends_at')::timestamptz   ELSE ends_at   END,
                day_date  = CASE WHEN v_prop_payload ? 'day_date'  THEN (v_prop_payload->>'day_date')::date         ELSE day_date  END,
                version = version + 1, updated_at = now()
               WHERE id = v_item_id;
              v_applied := jsonb_build_object('status', 'APPLIED', 'effect', 'plan_moved', 'plan_id', v_item_id);
            END IF;
          EXCEPTION WHEN check_violation OR invalid_datetime_format OR invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_PAYLOAD_INVALID',
              'detail', SQLERRM, 'contract_version', 2);
          END;

        ELSE
          -- add_commitment, stage_change, other. Accepted, and NOT applied,
          -- and the event says so — inventing an effect for `other` would be
          -- inventing product behaviour out of a vocabulary entry.
          v_applied := jsonb_build_object('status', 'NOT_APPLICABLE',
                                          'reason', 'PROPOSAL_TYPE_HAS_NO_CANONICAL_EFFECT',
                                          'proposal_type', v_role);
        END IF;

        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted',
                                       'applied', v_applied, 'decision_rule', v_decision_rule);$a$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2775: the transform did not grow the definition';
  END IF;
  -- TWO arms are added at this indentation and they are different KINDS. The
  -- counter every migration in this lane uses matches `\n      WHEN '`, which
  -- is the shape of both a COMMAND branch and a CAPABILITY arm — the kernel's
  -- capability CASE is indented the same. Every earlier migration added
  -- commands only, so the two had never needed telling apart. 2775 adds one of
  -- each, so the total is +2 and each is asserted by name below rather than
  -- hidden inside one number.
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 2 THEN
    RAISE EXCEPTION '2775: the transform added % arms, expected exactly 2 (one command branch, one capability arm)', n - branches_before;
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''VOTE_ON_PROPOSAL'' THEN', ''))) / length(E'\n      WHEN ''VOTE_ON_PROPOSAL'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2775: expected exactly 1 VOTE_ON_PROPOSAL command branch, found %', n; END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''proposal_rule'' THEN', ''))) / length(E'\n      WHEN ''proposal_rule'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2775: expected exactly 1 proposal_rule capability arm, found %', n; END IF;

  EXECUTE d;
END
$mig$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  FOREACH t IN ARRAY ARRAY['VOTE_ON_PROPOSAL','trip.proposal_voted','proposal_rule',
                           'trip_proposal_tally','trip_proposal_votes','proposed_by',
                           'decision_rule','TRIP_PROPOSAL_VOTE_NOT_MET',
                           'TRIP_PROPOSAL_PAYLOAD_INVALID','TRIP_PROPOSAL_RULE_UNKNOWN',
                           'PROPOSAL_TYPE_HAS_NO_CANONICAL_EFFECT'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2775: % missing after apply', t; END IF;
  END LOOP;

  -- The interim gating must be GONE, not merely supplemented: a surviving
  -- unconditional host check would silently outrank every other rule.
  IF position($chk$WHEN 'ACCEPT_PROPOSAL' THEN 'host'$chk$ in d) > 0 THEN
    RAISE EXCEPTION '2775: ACCEPT_PROPOSAL is still unconditionally host-gated; 2768''s interim rule survived';
  END IF;
  IF position($chk$WHEN 'ACCEPT_PROPOSAL' THEN 'proposal_rule'$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2775: ACCEPT_PROPOSAL is not gated on the proposal''s own rule';
  END IF;

  -- An unknown rule must refuse. The CHECK makes it unreachable today; the
  -- branch is what keeps a widened vocabulary from becoming permissive.
  IF position($chk$'reason', 'TRIP_PROPOSAL_RULE_UNKNOWN'$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2775: an unknown decision_rule does not fail closed';
  END IF;

  n := (length(d) - length(replace(d, 'v_family     := ''proposal'';', ''))) / length('v_family     := ''proposal'';');
  IF n <> 4 THEN RAISE EXCEPTION '2775: expected 4 proposal-family assignments (create, vote, accept, reject), found %', n; END IF;

  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_GOAL','SET_PRESENCE','JOIN_PLAN',
                           'RECORD_OUTCOME','SET_TRIP_COVER','JOIN_VIA_LINK','CREATE_TRIP',
                           'TRIP_VERSION_CONFLICT','trip_command_receipts','trip_outbox',
                           'TRIP_ROLE_GRANT_REQUIRES_OWNER'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2775: % was lost', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk','attendance'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2775: the %-family assignments became %', t, n; END IF;
  END LOOP;
END
$post$;

COMMIT;
