-- Rollback for 2775_trip_kernel_proposal_governance_and_apply.sql
--
-- Removes VOTE_ON_PROPOSAL, the proposal_rule capability, the vote check and
-- the APPLY step, returning ACCEPT_PROPOSAL and REJECT_PROPOSAL to 2768's
-- unconditional `host` gating and to flipping a status column.
--
-- READ THIS BEFORE RUNNING IT. After this file:
--   * every proposal is decided by a host again, whatever its decision_rule
--     says. A proposal created with decision_rule='unanimous' will be
--     acceptable by one co_host with no votes at all. The COLUMN survives and
--     is then a lie — it describes a rule nothing enforces.
--   * an accepted proposal stops changing anything. Acceptances recorded
--     BEFORE this rollback did change canonical state and are not undone;
--     acceptances after it will not, and the two are indistinguishable in
--     trip_proposals.
-- Run the 2774 rollback as well, or accept that decision_rule is decorative.
-- The postcondition warns when it is left behind.
--
-- ORDER: before 2772's rollback (this file's anchors are in branches 2768 and
-- 2775 wrote, and 2772 sits between them in the chain).
--
-- DATA: none. Votes survive, uncounted.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2775: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('VOTE_ON_PROPOSAL' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2775: not applied here';
  END IF;

  -- 6. The vote check and the APPLY step, back to a bare status flip.
  d := regexp_replace(d,
       $a$        -- §9\.3\. Under a counted rule the VOTE decides.*?        UPDATE public\.trip_proposals SET status = 'accepted', updated_at = now\(\)
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip\.proposal_accepted';
        v_result := jsonb_build_object\('id', v_proposal_id, 'status', 'accepted',
                                       'applied', v_applied, 'decision_rule', v_decision_rule\);$a$,
       $a$        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted');$a$,
       '');
  IF position('v_applied' in d) > 0 AND position('v_applied jsonb;' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2775: the apply step was only partly removed';
  END IF;

  -- 5. CREATE_PROPOSAL stops recording the author and the rule.
  d := regexp_replace(d,
       $a$                  coalesce\(\(v_payload->>'affected_version'\)::bigint, v_current\),\n(                  --[^\n]*\n)*                  v_actor,\n(                  --[^\n]*\n)*                  coalesce\(v_payload->>'decision_rule', 'host'\)\)$a$,
       $a$                  coalesce((v_payload->>'affected_version')::bigint, v_current))$a$,
       '');
  d := replace(d, $a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version,
             proposed_by, decision_rule)$a$,
                  $a$            (trip_id, proposal_type, payload_json, status, expires_at, affected_version)$a$);

  -- 4. The VOTE_ON_PROPOSAL branch.
  d := regexp_replace(d,
       $a$      WHEN 'VOTE_ON_PROPOSAL' THEN.*?      WHEN 'CREATE_PROPOSAL' THEN$a$,
       $a$      WHEN 'CREATE_PROPOSAL' THEN$a$,
       '');

  -- 3. The proposal_rule capability arm.
  d := regexp_replace(d,
       $a$      WHEN 'proposal_rule' THEN.*?      ELSE\n        NULL; -- 'system': the actor_role gate above is the whole check$a$,
       $a$      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check$a$,
       '');

  -- 2. The dispatch, back to unconditional host.
  d := replace(d, $a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'VOTE_ON_PROPOSAL' THEN 'crew'
    WHEN 'ACCEPT_PROPOSAL' THEN 'proposal_rule' WHEN 'REJECT_PROPOSAL' THEN 'proposal_rule'$a$,
                  $a$    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'$a$);

  -- 1. The locals.
  d := replace(d, E'  v_vote text;\n', '');
  d := replace(d, E'  v_decision_rule text;\n', '');
  d := replace(d, E'  v_tally jsonb;\n', '');
  d := replace(d, E'  v_applied jsonb;\n', '');
  d := replace(d, E'  v_prop_payload jsonb;\n', '');

  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 2 THEN
    RAISE EXCEPTION 'rollback 2775: the excision removed % arms, expected exactly 2 (one command branch, one capability arm)', branches_before - n;
  END IF;
  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2775: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['VOTE_ON_PROPOSAL','proposal_rule','trip_proposal_tally',
                           'trip_proposal_votes','v_tally','v_applied','v_prop_payload',
                           'v_decision_rule','v_vote','decision_rule','proposed_by',
                           'trip.proposal_voted','TRIP_PROPOSAL_VOTE_NOT_MET',
                           'TRIP_PROPOSAL_PAYLOAD_INVALID','TRIP_PROPOSAL_RULE_UNKNOWN'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2775: % survived', t; END IF;
  END LOOP;

  IF position($chk$WHEN 'ACCEPT_PROPOSAL' THEN 'host'$chk$ in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2775: 2768''s host gating did not come back';
  END IF;

  FOREACH t IN ARRAY ARRAY['CREATE_PROPOSAL','ACCEPT_PROPOSAL','REJECT_PROPOSAL',
                           'ADD_STAGE','ADD_LEG','ADD_GOAL','SET_PRESENCE','JOIN_PLAN',
                           'RECORD_OUTCOME','CREATE_TRIP','TRIP_VERSION_CONFLICT',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2775: % lost — the excision overran', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk','attendance'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION 'rollback 2775: the %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'v_family     := ''proposal'';', ''))) / length('v_family     := ''proposal'';');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2775: expected 3 proposal branches after removing the vote, found %', n; END IF;

  -- The column this file just stopped enforcing.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid='public.trip_proposals'::regclass
                AND attname='decision_rule' AND NOT attisdropped) THEN
    RAISE WARNING 'rollback 2775: trip_proposals.decision_rule still exists and NOTHING now enforces it. A proposal marked unanimous is acceptable by one co_host with no votes. Run the 2774 rollback too, or treat the column as decorative.';
  END IF;
END
$post$;

COMMIT;
