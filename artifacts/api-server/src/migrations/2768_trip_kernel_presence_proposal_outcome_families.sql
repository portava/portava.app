-- 2768_trip_kernel_presence_proposal_outcome_families.sql
--
-- Trips v4 §4: six commands across three tables —
--   SET_PRESENCE / CLEAR_PRESENCE                  -> trip_presence   (TR87)
--   CREATE_PROPOSAL / ACCEPT_PROPOSAL /
--     REJECT_PROPOSAL                              -> trip_proposals  (TR88)
--   RECORD_OUTCOME                                 -> trip_outcomes   (TR90)
--
-- Fourth in the §5 sequence, after 2764 (stages), 2765 (legs, commitments) and
-- 2766 (goals, decision tasks, risks).
--
-- THE COMMAND NAMES ARE THE SPEC'S, NOT LOCAL INVENTIONS. §4.1 lists
-- "SET_PRESENCE ... CREATE_PROPOSAL | ACCEPT_PROPOSAL" among its examples, and
-- §4.2 lists `trip.proposal_accepted` among its named events. Where the spec
-- names a command, this file uses that name even where a local convention would
-- have produced ADD_/UPDATE_/REMOVE_. REJECT_PROPOSAL is the one addition, and
-- it is not an invention either: `rejected` is in 2763's own status CHECK, and a
-- decision machine that can only say yes records refusals as silence.
--
-- BASE: the post-2766 kernel, asserted before anything is touched. This one also
-- requires 2767, because SET_PRESENCE writes `source` and the §10.1 vocabulary,
-- and applying it to a 2763-shaped trip_presence would produce a command that
-- fails on its first call.
--
-- NOT REHEARSED ON ANY SUPABASE DATABASE — see
-- docs/architecture/blocker-ledger.md, TRIP_KERNEL_NEVER_DEPLOYED. Rehearsed on
-- db/harness/run.sh.
--
-- THREE DECISIONS WORTH NAMING
-- ============================
-- 1. SET_PRESENCE is an UPSERT, not an ADD/UPDATE pair. trip_presence is keyed
--    (trip_id, user_id): a participant has exactly one presence, and splitting
--    the write in two would let a client observe a participant with none.
--
-- 2. A participant may set only their OWN presence, refusing
--    TRIP_PRESENCE_NOT_SELF otherwise. Presence is a claim about where a person
--    is; a claim someone else can write is not that person's presence. The
--    payload may name the actor explicitly and may not name anyone else.
--
-- 3. ACCEPT_PROPOSAL and REJECT_PROPOSAL require `host`, and that is an INTERIM
--    CHOICE, recorded rather than hidden. §9.3 gives a proposal a
--    `decisionRule: HOST | MAJORITY | UNANIMOUS | ANYONE`, and 2763's
--    trip_proposals has no such column, so the governance §9.3 describes cannot
--    be implemented here. `host` is the most conservative of the four — it can
--    be widened later without retroactively legitimising decisions a narrower
--    rule would have refused, and the reverse is not true. The missing column is
--    docs/architecture/blocker-ledger.md, PROPOSAL_DECISION_RULE. Until it
--    lands, TR88 is W and not C, and this migration does not claim otherwise.
--
-- OUTCOMES ARE APPEND-ONLY. There is no UPDATE_OUTCOME and no REMOVE_OUTCOME.
-- §20.1 builds durable memory out of outcomes; a record of what happened that
-- can be edited afterwards is not evidence. Corrections are new rows.
--
-- trip_snapshots (TR89) IS DELIBERATELY NOT HERE. A snapshot is a projection
-- artifact for replay (§22.1), not a canonical state transition, and writing one
-- through the kernel would bump trips.version — so the snapshot's
-- aggregate_version would be stale the instant it was written. Its writer is a
-- projection worker, in the shape of the one TR76 already has. That is the next
-- unit of work, and until it exists trip_snapshots has no writer and TR89 stays
-- N. Forcing a WRITE_SNAPSHOT command here would have closed the row and been
-- wrong.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2768 (Trips).

BEGIN;

DO $base$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2768: trip_kernel_execute not found'; END IF;
  IF position('SET_TRIP_COVER' in d) = 0 THEN
    RAISE EXCEPTION '2768: the installed kernel predates 2590. Apply 2450 -> 2500 -> 2590 -> 2764 -> 2765 -> 2766 first.';
  END IF;
  IF position('ADD_STAGE' in d) = 0 THEN RAISE EXCEPTION '2768: the installed kernel predates 2764.'; END IF;
  IF position('ADD_LEG' in d) = 0 THEN RAISE EXCEPTION '2768: the installed kernel predates 2765.'; END IF;
  IF position('ADD_GOAL' in d) = 0 THEN RAISE EXCEPTION '2768: the installed kernel predates 2766.'; END IF;

  -- 2767, not merely 2763: SET_PRESENCE writes `source` and the §10.1 states.
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid = 'public.trip_presence'::regclass AND attname = 'source' AND NOT attisdropped;
  IF n <> 1 THEN
    RAISE EXCEPTION '2768: trip_presence has no source column, so 2767 has not been applied. SET_PRESENCE would fail on its first call.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.trip_presence'::regclass AND conname = 'trip_presence_state_known'
     AND position('at_plan' in pg_get_constraintdef(oid)) > 0;
  IF n <> 1 THEN
    RAISE EXCEPTION '2768: trip_presence still carries the pre-2767 state vocabulary; the §10.1 states this command writes would all be refused.';
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

  IF position('SET_PRESENCE' in d) > 0 OR position('CREATE_PROPOSAL' in d) > 0
     OR position('RECORD_OUTCOME' in d) > 0 THEN
    RAISE EXCEPTION '2768: one of these families is already present; this migration is not idempotent by design';
  END IF;

  -- 1. the ids and the two timestamps SET_PRESENCE derives
  n := (length(d) - length(replace(d, '  v_risk_id    uuid;', ''))) / length('  v_risk_id    uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2768: anchor v_risk_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_risk_id    uuid;',
                  '  v_risk_id    uuid;'          || E'\n' ||
                  '  v_proposal_id uuid;'         || E'\n' ||
                  '  v_proposal_status text;'     || E'\n' ||
                  '  v_outcome_id uuid;'          || E'\n' ||
                  '  v_observed_at timestamptz;'  || E'\n' ||
                  '  v_expires_at  timestamptz;');

  -- 2. capability dispatch. Presence and outcomes are crew. The two proposal
  --    DECISIONS are host, for the reason in this file's header; CREATING a
  --    proposal is crew, because §9.3's whole point is that anyone may propose
  --    and not everyone may decide.
  n := (length(d) - length(replace(d, $a$    WHEN 'ADD_GOAL' THEN 'crew'$a$, ''))) / length($a$    WHEN 'ADD_GOAL' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2768: anchor ADD_GOAL dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_GOAL' THEN 'crew'$a$,
                  $a$    WHEN 'SET_PRESENCE' THEN 'crew' WHEN 'CLEAR_PRESENCE' THEN 'crew'
    WHEN 'CREATE_PROPOSAL' THEN 'crew' WHEN 'ACCEPT_PROPOSAL' THEN 'host' WHEN 'REJECT_PROPOSAL' THEN 'host'
    WHEN 'RECORD_OUTCOME' THEN 'crew'
    WHEN 'ADD_GOAL' THEN 'crew'$a$);

  -- 3. the branches, inserted before the goal family
  n := (length(d) - length(replace(d, E'      WHEN ''ADD_GOAL'' THEN', ''))) / length(E'      WHEN ''ADD_GOAL'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2768: anchor ADD_GOAL branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''ADD_GOAL'' THEN', $branches$      WHEN 'SET_PRESENCE' THEN
        -- §10.1. One row per participant per trip, so this is an UPSERT and not
        -- an ADD/UPDATE pair: a participant has exactly one presence, and two
        -- commands for one row would let a client observe a state where it has
        -- none.
        IF coalesce(v_payload->>'presence_state','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'presence_state is required', 'contract_version', 2);
        END IF;
        -- You may set YOUR presence. Nobody may set anyone else's: presence is a
        -- claim about where a person is, and a claim someone else can write is
        -- not that person's presence. The payload may name the actor
        -- explicitly, and may not name anyone else.
        IF (v_payload->>'user_id') IS NOT NULL
           AND (v_payload->>'user_id')::uuid IS DISTINCT FROM v_actor THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PRESENCE_NOT_SELF', 'contract_version', 2);
        END IF;
        v_observed_at := coalesce((v_payload->>'observed_at')::timestamptz, v_observed, now());
        IF (v_payload->>'expires_at') IS NOT NULL THEN
          v_expires_at := (v_payload->>'expires_at')::timestamptz;
        ELSIF (v_payload->>'ttl_seconds') IS NOT NULL THEN
          v_expires_at := v_observed_at + make_interval(secs => (v_payload->>'ttl_seconds')::numeric);
        ELSE
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'expires_at or ttl_seconds is required: §10.1 presence has a TTL and a row without one never goes stale',
            'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_presence
            (trip_id, user_id, presence_state, visibility, observed_at, expires_at, confidence, source)
          VALUES (v_trip_id, v_actor, v_payload->>'presence_state',
                  coalesce(v_payload->>'visibility','crew'),
                  v_observed_at, v_expires_at,
                  (v_payload->>'confidence')::numeric,
                  coalesce(v_payload->>'source','explicit'))
          ON CONFLICT (trip_id, user_id) DO UPDATE SET
            presence_state = EXCLUDED.presence_state,
            visibility     = EXCLUDED.visibility,
            observed_at    = EXCLUDED.observed_at,
            expires_at     = EXCLUDED.expires_at,
            confidence     = EXCLUDED.confidence,
            source         = EXCLUDED.source;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR numeric_value_out_of_range OR datetime_field_overflow THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'presence';
        v_event_type := 'trip.presence_set';
        v_result := jsonb_build_object('user_id', v_actor, 'expires_at', v_expires_at);

      WHEN 'CLEAR_PRESENCE' THEN
        DELETE FROM public.trip_presence WHERE trip_id = v_trip_id AND user_id = v_actor;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PRESENCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'presence';
        v_event_type := 'trip.presence_cleared';
        v_result := jsonb_build_object('user_id', v_actor);

      WHEN 'CREATE_PROPOSAL' THEN
        -- §9.3. The command name is the spec's, not a local invention.
        IF coalesce(v_payload->>'proposal_type','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'proposal_type is required', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_proposals
            (trip_id, proposal_type, payload_json, status, expires_at, affected_version)
          VALUES (v_trip_id, v_payload->>'proposal_type',
                  coalesce(v_payload->'payload_json', '{}'::jsonb),
                  'pending',
                  (v_payload->>'expires_at')::timestamptz,
                  -- The version the proposal was written against. Defaults to
                  -- the trip's version as this command observed it, so a
                  -- proposal always records what it was reasoning about.
                  coalesce((v_payload->>'affected_version')::bigint, v_current))
          RETURNING id INTO v_proposal_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_created';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'pending');

      WHEN 'ACCEPT_PROPOSAL' THEN
        v_proposal_id := (v_payload->>'proposal_id')::uuid;
        IF v_proposal_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        SELECT status INTO v_proposal_status FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        -- Only a pending proposal has a decision left to make. Accepting an
        -- already-rejected one is not a late accept, it is a second decision
        -- overwriting a recorded first.
        IF v_proposal_status <> 'pending' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_PENDING',
            'status', v_proposal_status, 'contract_version', 2);
        END IF;
        UPDATE public.trip_proposals SET status = 'accepted', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_accepted';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'accepted');

      WHEN 'REJECT_PROPOSAL' THEN
        v_proposal_id := (v_payload->>'proposal_id')::uuid;
        IF v_proposal_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        SELECT status INTO v_proposal_status FROM public.trip_proposals
         WHERE id = v_proposal_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_proposal_status <> 'pending' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PROPOSAL_NOT_PENDING',
            'status', v_proposal_status, 'contract_version', 2);
        END IF;
        UPDATE public.trip_proposals SET status = 'rejected', updated_at = now()
         WHERE id = v_proposal_id AND trip_id = v_trip_id;
        v_family     := 'proposal';
        v_event_type := 'trip.proposal_rejected';
        v_result := jsonb_build_object('id', v_proposal_id, 'status', 'rejected');

      WHEN 'RECORD_OUTCOME' THEN
        -- §20.1: durable memory is built from outcomes. There is no
        -- UPDATE_OUTCOME and no REMOVE_OUTCOME, and that is the point — a
        -- record of what happened that can be edited afterwards is not
        -- evidence. Corrections are new rows.
        IF coalesce(v_payload->>'outcome_type','') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'outcome_type is required', 'contract_version', 2);
        END IF;
        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        BEGIN
          INSERT INTO public.trip_outcomes
            (trip_id, stage_id, plan_id, outcome_type, occurred_at, evidence_json)
          VALUES (v_trip_id, (v_payload->>'stage_id')::uuid, (v_payload->>'plan_id')::uuid,
                  v_payload->>'outcome_type',
                  coalesce((v_payload->>'occurred_at')::timestamptz, v_observed, now()),
                  coalesce(v_payload->'evidence_json', '{}'::jsonb))
          RETURNING id INTO v_outcome_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'outcome';
        v_event_type := 'trip.outcome_recorded';
        v_result := jsonb_build_object('id', v_outcome_id);

      WHEN 'ADD_GOAL' THEN$branches$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2768: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 6 THEN
    RAISE EXCEPTION '2768: the transform added % command branches, expected exactly 6', n - branches_before;
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

  FOREACH t IN ARRAY ARRAY['SET_PRESENCE','CLEAR_PRESENCE','CREATE_PROPOSAL',
                           'ACCEPT_PROPOSAL','REJECT_PROPOSAL','RECORD_OUTCOME',
                           'trip.presence_set','trip.presence_cleared',
                           'trip.proposal_created','trip.proposal_accepted',
                           'trip.proposal_rejected','trip.outcome_recorded',
                           'TRIP_PRESENCE_NOT_SELF','TRIP_PRESENCE_NOT_FOUND',
                           'TRIP_PROPOSAL_NOT_FOUND','TRIP_PROPOSAL_NOT_PENDING'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2768: % missing after apply', t; END IF;
  END LOOP;

  -- Ledger attribution, per family.
  -- Branch counts differ per family here: presence has 2 commands, proposal 3,
  -- outcome 1. The expected count travels with the name so the pair cannot
  -- drift apart the way a hand-maintained second list would.
  FOREACH t IN ARRAY ARRAY['presence:2','proposal:3','outcome:1'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || split_part(t,':',1) || ''';', '')))
         / length('v_family     := ''' || split_part(t,':',1) || ''';');
    IF n <> split_part(t,':',2)::int THEN
      RAISE EXCEPTION '2768: expected % %-family assignments, found %', split_part(t,':',2), split_part(t,':',1), n;
    END IF;
  END LOOP;

  -- The proposal decisions must be host, not crew. A widened capability that
  -- reached production would legitimise decisions §9.3's narrowest rule refuses.
  IF position($chk$WHEN 'ACCEPT_PROPOSAL' THEN 'host'$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2768: ACCEPT_PROPOSAL is not host-gated';
  END IF;
  IF position($chk$WHEN 'REJECT_PROPOSAL' THEN 'host'$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2768: REJECT_PROPOSAL is not host-gated';
  END IF;

  -- What this transform did not name, it must not have moved.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','ADD_GOAL','ADD_RISK',
                           'ADD_DECISION_TASK','SET_TRIP_COVER','JOIN_VIA_LINK','CREATE_TRIP',
                           'REMOVE_PLAN','TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2768: % was lost', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2768: the earlier %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION '2768: expected the 2 pre-existing trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
