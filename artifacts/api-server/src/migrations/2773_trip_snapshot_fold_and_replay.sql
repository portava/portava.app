-- 2773_trip_snapshot_fold_and_replay.sql
--
-- Trips v4 §22.1 (snapshot contract) and §22.2 (deterministic replay). Gives
-- `trip_snapshots` (2763) the writer census-trips TR89 needs — and, more to the
-- point, gives §22.2 the FOLD it is a statement about.
--
-- WHY THIS IS NOT A KERNEL COMMAND
-- ================================
-- 2768's header explains it and this file is the other half: a snapshot is a
-- projection artifact for replay, not a canonical state transition. Writing one
-- through trip_kernel_execute would bump trips.version, so the snapshot's
-- aggregate_version would be stale the instant it was written. It is a reader
-- of the event log, in the shape lib/mapTripProjectionWorker.ts + 2520 already
-- established for the §19.4 map projection.
--
-- WHAT §22.2 ACTUALLY ASKS FOR
-- ============================
--   "Engineering can replay a Trip from a snapshot plus ordered events and
--    compare resulting canonical/projection state."
--
-- That is a property of a FOLD, and it is only meaningful if there is exactly
-- one fold. So there is one function, `public.trip_snapshot_fold`, and both
-- paths go through it:
--
--   full replay    fold(seed, events 1..n)
--   snapshot+tail  fold(snapshot_at_k, events k+1..n)
--
-- and the property is that those two are EQUAL. `trip_snapshot_verify_replay`
-- computes both and returns the comparison, so the property is executable
-- rather than asserted; db/harness/probe_snapshot_replay.sql runs it.
--
-- THE FOLD READS EVENTS, NOT TABLES
-- =================================
-- A "snapshot" built by selecting from trip_stages and trip_plan_items would be
-- a copy of current state and would prove nothing about replay: it would agree
-- with the tables by construction and diverge from the event log silently. This
-- fold reads `trip_events.payload_json` only.
--
-- That is possible because the kernel records both halves of every command: the
-- `payload` key carries the input and `result` carries the row or the id. A
-- create carries its whole row (`to_jsonb(v_row)`), an update carries the patch
-- and the id, a remove carries the id. Nothing in this fold needs a table.
--
-- DETERMINISM, AND WHAT WOULD BREAK IT
-- ====================================
-- Events are folded in `sequence` order, which 2420 makes dense and unique per
-- trip. jsonb object key order is not part of jsonb equality in Postgres, so
-- two folds that assign the same keys compare equal regardless of assignment
-- order. The fold contains no now(), no random, no coalesce over a table read,
-- and no ordering by a nullable column — every one of which would make a replay
-- disagree with itself. `trip_snapshot_verify_replay` is what would catch it.
--
-- WHAT THE SNAPSHOT DOES NOT CONTAIN, AND WHY THAT IS WRITTEN DOWN
-- ================================================================
-- §22.1's contract names `freeWindowSummary`. A free window is §7's temporal
-- consistency engine and that engine does not exist in this tree (census-trips
-- TR128/TR134). The key is present and its value is
--   {"available": false, "reason": "SECTION_7_ENGINE_ABSENT"}
-- NOT an empty object and NOT omitted. An absent key reads as "no free
-- windows"; an empty object reads as "computed, found none". Both are false and
-- both are indistinguishable from the truth, which is that nothing computed it.
-- §22.1's `sourceRefs` is likewise present and explicitly unpopulated: the
-- kernel's events do not carry source refs today.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2773 (Trips).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_snapshots') IS NULL THEN
    RAISE EXCEPTION '2773: requires 2763 (trip_snapshots)';
  END IF;
  IF to_regclass('public.trip_events') IS NULL THEN
    RAISE EXCEPTION '2773: requires 2420 (trip_events)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.trip_events'::regclass
                    AND attname='sequence' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2773: trip_events has no sequence column; the fold has no deterministic order';
  END IF;
END
$pre$;

-- ── The seed. A trip before its first event. ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_snapshot_seed(p_trip_id uuid)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT jsonb_build_object(
    'snapshot_schema_version', 1,
    'trip_id', p_trip_id,
    'aggregate_version', 0,
    'lifecycle_state', NULL,
    'stage_id', NULL,
    'active_plan_id', NULL,
    'next_commitment_id', NULL,
    'stages', '{}'::jsonb,
    'plans', '{}'::jsonb,
    'commitments', '{}'::jsonb,
    'legs', '{}'::jsonb,
    'goals', '{}'::jsonb,
    'decision_tasks', '{}'::jsonb,
    'proposals', '{}'::jsonb,
    'outcomes', '{}'::jsonb,
    'crew_summary', '{}'::jsonb,
    'risk_summary', '{}'::jsonb,
    'attendance', '{}'::jsonb,
    -- §22.1 names these. Present and explicitly unavailable: an absent key
    -- reads as "none", which is a claim nothing here is entitled to make.
    'free_window_summary', jsonb_build_object('available', false, 'reason', 'SECTION_7_ENGINE_ABSENT'),
    'source_refs',        jsonb_build_object('available', false, 'reason', 'NOT_CARRIED_BY_EVENTS'));
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_seed(uuid) IS
  'Trips spec §22.1: the state of a trip before its first event. IMMUTABLE and parameterless beyond the id, so a replay from zero is reproducible.';

-- ── The fold. ONE implementation, used by both replay paths. ─────────────────
CREATE OR REPLACE FUNCTION public.trip_snapshot_fold(p_state jsonb, p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  s     jsonb := p_state;
  t     text  := p_event->>'type';
  pay   jsonb := coalesce(p_event->'payload_json'->'payload', '{}'::jsonb);
  res   jsonb := coalesce(p_event->'payload_json'->'result', '{}'::jsonb);
  ver   bigint := (p_event->>'aggregate_version')::bigint;
  k     text;
  cur   jsonb;
BEGIN
  -- Version first: every event advances it, whatever else it does.
  s := jsonb_set(s, '{aggregate_version}', to_jsonb(ver));

  CASE
    -- ── trip lifecycle ──────────────────────────────────────────────────────
    WHEN t IN ('trip.created', 'trip.updated') THEN
      s := jsonb_set(s, '{lifecycle_state}', to_jsonb(coalesce(res->>'status', s->>'lifecycle_state')));
    WHEN t IN ('trip.trip_completed', 'trip.trip_cancelled', 'trip.trip_archived') THEN
      s := jsonb_set(s, '{lifecycle_state}', to_jsonb(
             coalesce(pay->>'status_to', res->>'status', s->>'lifecycle_state')));
    WHEN t = 'trip.hidden_by_admin' OR t = 'trip.cover_set' THEN
      NULL;  -- neither changes any field this snapshot carries

    -- ── stages ──────────────────────────────────────────────────────────────
    WHEN t = 'trip.stage_added' THEN
      k := res->>'id';
      s := jsonb_set(s, ARRAY['stages', k], jsonb_build_object(
             'stage_type', pay->>'stage_type',
             'state',      coalesce(pay->>'state', 'planned'),
             'sequence',   (pay->>'sequence'),
             'timezone',   pay->>'timezone'));
    WHEN t = 'trip.stage_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'stages'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['stages', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.stage_removed' THEN
      s := jsonb_set(s, '{stages}', (s->'stages') - (res->>'id'));

    -- ── plans ───────────────────────────────────────────────────────────────
    WHEN t = 'trip.plan_added' THEN
      k := res->>'id';
      s := jsonb_set(s, ARRAY['plans', k], jsonb_build_object(
             'title',         res->>'title',
             'status',        res->>'status',
             'stage_id',      res->>'stage_id',
             'privacy_scope', res->>'privacy_scope',
             'plan_scope',    res->>'plan_scope'));
    WHEN t IN ('trip.plan_updated','trip.plan_moved','trip.plan_confirmed',
               'trip.plan_cancelled','trip.plan_completed') THEN
      k := res->>'id';
      cur := coalesce(s->'plans'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['plans', k], cur || jsonb_strip_nulls(jsonb_build_object(
             'title',         res->>'title',
             'status',        res->>'status',
             'stage_id',      res->>'stage_id',
             'privacy_scope', res->>'privacy_scope',
             'plan_scope',    res->>'plan_scope')));
    WHEN t = 'trip.plan_removed' THEN
      s := jsonb_set(s, '{plans}', (s->'plans') - (res->>'id'));
    WHEN t IN ('trip.plan_reordered','trip.plan_route_stop_linked') THEN
      NULL;  -- neither changes a field this snapshot carries

    -- ── commitments ─────────────────────────────────────────────────────────
    WHEN t = 'trip.commitment_added' THEN
      k := res->>'id';
      s := jsonb_set(s, ARRAY['commitments', k], jsonb_strip_nulls(jsonb_build_object(
             'type',                pay->>'type',
             'starts_at',           pay->>'starts_at',
             'required_arrival_at', pay->>'required_arrival_at',
             'flexibility',         coalesce(pay->>'flexibility','flexible'),
             'stage_id',            pay->>'stage_id')));
    WHEN t = 'trip.commitment_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'commitments'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['commitments', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.commitment_removed' THEN
      s := jsonb_set(s, '{commitments}', (s->'commitments') - (res->>'id'));

    -- ── crew ────────────────────────────────────────────────────────────────
    WHEN t IN ('trip.participant_invited','trip.participant_added',
               'trip.participant_joined','trip.participant_role_set') THEN
      k := res->>'user_id';
      s := jsonb_set(s, ARRAY['crew_summary', k], jsonb_build_object(
             'role',   res->>'role',
             'status', res->>'status'));
    WHEN t IN ('trip.participant_removed','trip.participant_declined') THEN
      s := jsonb_set(s, '{crew_summary}', (s->'crew_summary') - (res->>'user_id'));

    -- ── risks ───────────────────────────────────────────────────────────────
    WHEN t = 'trip.risk_added' THEN
      s := jsonb_set(s, ARRAY['risk_summary', res->>'id'], jsonb_build_object(
             'likelihood', pay->>'likelihood',
             'impact',     pay->>'impact',
             'status',     coalesce(pay->>'status','open')));
    WHEN t = 'trip.risk_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'risk_summary'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['risk_summary', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.risk_removed' THEN
      s := jsonb_set(s, '{risk_summary}', (s->'risk_summary') - (res->>'id'));

    -- ── legs ────────────────────────────────────────────────────────────────
    WHEN t = 'trip.leg_added' THEN
      s := jsonb_set(s, ARRAY['legs', res->>'id'], jsonb_strip_nulls(jsonb_build_object(
             'leg_type',      pay->>'leg_type',
             'from_stage_id', pay->>'from_stage_id',
             'to_stage_id',   pay->>'to_stage_id',
             'starts_at',     pay->>'starts_at',
             'ends_at',       pay->>'ends_at')));
    WHEN t = 'trip.leg_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'legs'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['legs', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.leg_removed' THEN
      s := jsonb_set(s, '{legs}', (s->'legs') - (res->>'id'));

    -- ── goals ───────────────────────────────────────────────────────────────
    WHEN t = 'trip.goal_added' THEN
      s := jsonb_set(s, ARRAY['goals', res->>'id'], jsonb_build_object(
             'type',     pay->>'type',
             'priority', coalesce(pay->>'priority','normal'),
             'status',   coalesce(pay->>'status','open')));
    WHEN t = 'trip.goal_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'goals'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['goals', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.goal_removed' THEN
      s := jsonb_set(s, '{goals}', (s->'goals') - (res->>'id'));

    -- ── decision tasks ──────────────────────────────────────────────────────
    WHEN t = 'trip.decision_task_added' THEN
      s := jsonb_set(s, ARRAY['decision_tasks', res->>'id'], jsonb_strip_nulls(jsonb_build_object(
             'type',             pay->>'type',
             'status',           coalesce(pay->>'status','pending'),
             'deadline_at',      pay->>'deadline_at',
             'assigned_user_id', pay->>'assigned_user_id')));
    WHEN t = 'trip.decision_task_updated' THEN
      k := res->>'id';
      cur := coalesce(s->'decision_tasks'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['decision_tasks', k], cur || coalesce(pay->'patch', '{}'::jsonb));
    WHEN t = 'trip.decision_task_removed' THEN
      s := jsonb_set(s, '{decision_tasks}', (s->'decision_tasks') - (res->>'id'));

    -- ── proposals (§9.3 governance state IS aggregate state) ────────────────
    WHEN t = 'trip.proposal_created' THEN
      s := jsonb_set(s, ARRAY['proposals', res->>'id'], jsonb_build_object(
             'proposal_type', pay->>'proposal_type',
             'status',        coalesce(res->>'status','pending')));
    -- A vote changes the tally, not the proposal's own state. The snapshot
    -- carries proposal STATUS; who voted which way lives in
    -- trip_proposal_votes and is read there, not reconstructed here — a
    -- version-addressed snapshot of a vote in progress would be a tally that
    -- looks settled.
    WHEN t = 'trip.proposal_voted' THEN
      NULL;
    WHEN t IN ('trip.proposal_accepted','trip.proposal_rejected') THEN
      k := res->>'id';
      cur := coalesce(s->'proposals'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['proposals', k], cur || jsonb_build_object('status', res->>'status'));

    -- ── outcomes (§20.1: append-only, so the fold only ever adds) ───────────
    WHEN t = 'trip.outcome_recorded' THEN
      s := jsonb_set(s, ARRAY['outcomes', res->>'id'], jsonb_strip_nulls(jsonb_build_object(
             'outcome_type', pay->>'outcome_type',
             'occurred_at',  pay->>'occurred_at',
             'stage_id',     pay->>'stage_id')));

    -- ── presence: DELIBERATELY NOT FOLDED ───────────────────────────────────
    -- Presence carries expires_at and §10.2 forbids drawing a stale observation
    -- as if it were current. A snapshot is addressed by VERSION, not by time, so
    -- a presence row folded at version k would be replayed later with no way to
    -- tell whether it had expired in between — which is exactly the thing §10.2
    -- rules out. Presence is read live from trip_presence or not at all.
    WHEN t IN ('trip.presence_set', 'trip.presence_cleared') THEN
      NULL;

    -- ── attendance ──────────────────────────────────────────────────────────
    WHEN t IN ('trip.plan_joined','trip.plan_attendance_set') THEN
      k := (res->>'plan_id') || '/' || (res->>'user_id');
      s := jsonb_set(s, ARRAY['attendance', k], to_jsonb(res->>'attendance_state'));
    WHEN t = 'trip.plan_left' THEN
      k := (res->>'plan_id') || '/' || (res->>'user_id');
      IF coalesce((res->>'row_removed')::boolean, false) THEN
        s := jsonb_set(s, '{attendance}', (s->'attendance') - k);
      ELSE
        s := jsonb_set(s, ARRAY['attendance', k], to_jsonb('left'::text));
      END IF;

    ELSE
      -- An event type this fold does not know. NOT ignored silently: the
      -- snapshot records that it was seen and could not be applied, so a
      -- replay comparison and any reader can both tell that this state is
      -- incomplete rather than merely uneventful.
      s := jsonb_set(s, ARRAY['unfolded'],
             coalesce(s->'unfolded', '{}'::jsonb) ||
             jsonb_build_object(t, coalesce((s->'unfolded'->>t)::int, 0) + 1));
  END CASE;

  -- Derived fields, recomputed from the folded state so they can never drift
  -- from the collections they summarise.
  s := jsonb_set(s, '{stage_id}', coalesce(
         (SELECT to_jsonb(e.key) FROM jsonb_each(s->'stages') e
           WHERE e.value->>'state' = 'active'
           ORDER BY (e.value->>'sequence')::numeric NULLS LAST, e.key
           LIMIT 1), 'null'::jsonb));
  s := jsonb_set(s, '{active_plan_id}', coalesce(
         (SELECT to_jsonb(e.key) FROM jsonb_each(s->'plans') e
           WHERE e.value->>'status' = 'confirmed'
           ORDER BY e.key
           LIMIT 1), 'null'::jsonb));
  s := jsonb_set(s, '{next_commitment_id}', coalesce(
         (SELECT to_jsonb(e.key) FROM jsonb_each(s->'commitments') e
           WHERE e.value->>'starts_at' IS NOT NULL
           ORDER BY (e.value->>'starts_at'), e.key
           LIMIT 1), 'null'::jsonb));

  RETURN s;
END
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_fold(jsonb, jsonb) IS
  'Trips spec §22.2: THE fold. One event onto one state, reading trip_events.payload_json only and never a table — a snapshot built from current tables would agree with them by construction and prove nothing about replay. IMMUTABLE: no now(), no random, no table read, so fold(seed, 1..n) and fold(snapshot_at_k, k+1..n) are equal by construction and trip_snapshot_verify_replay proves it. An unknown event type is COUNTED under `unfolded` rather than ignored, so incomplete state is distinguishable from uneventful state.';

-- ── Fold an ORDERED array. Defined before trip_snapshot_replay because that
-- one is LANGUAGE sql and is parsed at creation: a forward reference is a
-- creation-time error, not a runtime one.
CREATE OR REPLACE FUNCTION public.trip_snapshot_fold_all(p_from jsonb, p_events jsonb[])
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE s jsonb := p_from; e jsonb;
BEGIN
  IF p_events IS NULL THEN RETURN s; END IF;
  FOREACH e IN ARRAY p_events LOOP
    s := public.trip_snapshot_fold(s, e);
  END LOOP;
  RETURN s;
END
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_fold_all(jsonb, jsonb[]) IS
  'Trips spec §22.2: fold an ORDERED array of events onto a state. Takes an array rather than a query so the order is the caller''s explicit ORDER BY and never the planner''s choice — an aggregate over an unordered set would be nondeterministic in exactly the way §22.2 exists to rule out.';


-- ── Replay: fold a range of events onto a state. ─────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_snapshot_replay(
  p_trip_id uuid, p_from jsonb, p_after_version bigint, p_to_version bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
  -- array_agg with an explicit ORDER BY inside it: the order is stated here and
  -- not left to the planner. An aggregate over an unordered set would be
  -- nondeterministic in exactly the way §22.2 exists to rule out.
  SELECT public.trip_snapshot_fold_all(
           p_from,
           array_agg(jsonb_build_object('type', e.type,
                                        'aggregate_version', e.aggregate_version,
                                        'payload_json', e.payload_json)
                     ORDER BY e.sequence))
    FROM public.trip_events e
   WHERE e.trip_id = p_trip_id
     AND e.aggregate_version > p_after_version
     AND (p_to_version IS NULL OR e.aggregate_version <= p_to_version);
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_replay(uuid, jsonb, bigint, bigint) IS
  'Trips spec §22.2: fold the events of one trip in (p_after_version, p_to_version] onto a state. With no events in range array_agg returns NULL and trip_snapshot_fold_all returns the state unchanged, so replaying an empty tail is the identity — which is what makes fold(snapshot_at_head, nothing) equal fold(seed, 1..head).';

-- ── Write a snapshot at a version. ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_snapshot_write(p_trip_id uuid, p_at_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE v bigint; st jsonb; v_id uuid;
BEGIN
  SELECT coalesce(p_at_version, max(aggregate_version)) INTO v
    FROM public.trip_events WHERE trip_id = p_trip_id;
  IF v IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SNAPSHOT_NO_EVENTS');
  END IF;

  st := public.trip_snapshot_replay(p_trip_id, public.trip_snapshot_seed(p_trip_id), 0, v);

  INSERT INTO public.trip_snapshots (trip_id, aggregate_version, snapshot_json, engine_versions_json)
  VALUES (p_trip_id, v, st,
          jsonb_build_object('snapshot_fold', 1, 'section_7_free_window', NULL))
  ON CONFLICT (trip_id, aggregate_version) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'aggregate_version', v);
  END IF;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'aggregate_version', v);
END
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_write(uuid, bigint) IS
  'Trips spec §22.1: build and store a snapshot at an aggregate_version (default: the trip''s latest). Idempotent by (trip_id, aggregate_version), which 2763 makes unique — re-running it writes nothing and says duplicate, so a scheduler that overlaps itself cannot produce two snapshots of one version.';

-- ── The §22.2 property, executable. ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_snapshot_verify_replay(p_trip_id uuid, p_at_version bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE full_state jsonb; snap jsonb; tail jsonb; head bigint;
BEGIN
  SELECT max(aggregate_version) INTO head FROM public.trip_events WHERE trip_id = p_trip_id;
  IF head IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SNAPSHOT_NO_EVENTS');
  END IF;

  -- Path A: replay everything from the seed.
  full_state := public.trip_snapshot_replay(p_trip_id, public.trip_snapshot_seed(p_trip_id), 0, head);

  -- Path B: the stored snapshot at p_at_version, plus the tail.
  SELECT snapshot_json INTO snap FROM public.trip_snapshots
   WHERE trip_id = p_trip_id AND aggregate_version = p_at_version;
  IF snap IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SNAPSHOT_NOT_FOUND',
                              'at_version', p_at_version);
  END IF;
  tail := public.trip_snapshot_replay(p_trip_id, snap, p_at_version, head);

  RETURN jsonb_build_object(
    'ok', full_state = tail,
    'head_version', head,
    'snapshot_version', p_at_version,
    'equal', full_state = tail,
    -- On failure, name the keys that differ. "They are not equal" is not a
    -- finding anyone can act on.
    'differing_keys', CASE WHEN full_state = tail THEN '[]'::jsonb ELSE
      (SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb)
         FROM (SELECT jsonb_object_keys(full_state) k) a
        WHERE full_state->k IS DISTINCT FROM tail->k) END,
    'unfolded', coalesce(full_state->'unfolded', '{}'::jsonb));
END
$fn$;

COMMENT ON FUNCTION public.trip_snapshot_verify_replay(uuid, bigint) IS
  'Trips spec §22.2, executable: computes fold(seed, 1..head) and fold(snapshot_at_k, k+1..head) and returns whether they are EQUAL, naming the differing keys when they are not. This is the property §22.2 states; without it "deterministic replay" is a claim about code nobody ran.';

REVOKE ALL ON FUNCTION public.trip_snapshot_write(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_snapshot_verify_replay(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_snapshot_write(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_snapshot_verify_replay(uuid, bigint) TO service_role;

DO $post$
DECLARE t text; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_snapshot_seed','trip_snapshot_fold','trip_snapshot_fold_all',
                           'trip_snapshot_replay','trip_snapshot_write','trip_snapshot_verify_replay'] LOOP
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
     WHERE ns.nspname='public' AND p.proname=t;
    IF n <> 1 THEN RAISE EXCEPTION '2773: % is absent after apply', t; END IF;
  END LOOP;

  -- The fold must be IMMUTABLE. A VOLATILE fold could read a table or a clock,
  -- and §22.2's whole property would be unprovable.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname IN ('trip_snapshot_fold','trip_snapshot_fold_all','trip_snapshot_seed')
     AND p.provolatile = 'i';
  IF n <> 3 THEN RAISE EXCEPTION '2773: expected 3 IMMUTABLE fold functions, found %', n; END IF;

  -- Neither writer nor verifier may be reachable by a client role.
  IF has_function_privilege('anon', 'public.trip_snapshot_write(uuid, bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_snapshot_write(uuid, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION '2773: a client role can EXECUTE trip_snapshot_write';
  END IF;

  -- The seed carries §22.1's names, and the two it cannot compute say so.
  IF (public.trip_snapshot_seed('00000000-0000-0000-0000-000000000000')->'free_window_summary'->>'reason')
     IS DISTINCT FROM 'SECTION_7_ENGINE_ABSENT' THEN
    RAISE EXCEPTION '2773: free_window_summary does not declare itself unavailable';
  END IF;
  IF (public.trip_snapshot_seed('00000000-0000-0000-0000-000000000000')->'source_refs'->>'available')::boolean THEN
    RAISE EXCEPTION '2773: source_refs claims to be available';
  END IF;

  -- And the fold is a no-op on an unknown event rather than a silent loss.
  IF (public.trip_snapshot_fold(
        public.trip_snapshot_seed('00000000-0000-0000-0000-000000000000'),
        jsonb_build_object('type','trip.not_a_real_event','aggregate_version',1,
                           'payload_json','{}'::jsonb))->'unfolded'->>'trip.not_a_real_event')
     IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION '2773: an unknown event type is not counted under unfolded';
  END IF;
END
$post$;

COMMIT;
