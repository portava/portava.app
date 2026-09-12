-- 2787_trip_snapshot_fold_vocabulary.sql
--
-- Trips spec §22.1 / §22.2 — the snapshot fold names every event the kernel
-- emits. census-trips TR406, TR409 (the replay contract), and the contract
-- test src/test/tripSnapshotReplayContract.test.ts: "every TRIP_EVENT_TYPE is
-- either folded or explicitly a no-op — nothing falls through to `unfolded`
-- by accident".
--
-- 2773 wrote trip_snapshot_fold for the vocabulary of its day. 2779–2786
-- added eighteen event types, and the fold met each with 'unfolded': the
-- replay still agreed with itself (trip_snapshot_verify_replay compares
-- two folds of the same tail), but a plan started or a stage completed did
-- not reach the snapshot, so a snapshot taken after them was wrong about
-- `plans.*.status` and `stages.*.state` — the two fields §22.1 carries and
-- those events change.
--
-- WHAT THIS FILE DOES, by 2764's method on trip_snapshot_fold:
--   * trip.plan_started / trip.plan_skipped join the plan-status branch: the
--     result is the plan row, so `status` folds exactly as plan_completed's.
--   * trip.stage_started / trip.stage_completed fold `state` into the stage.
--   * the twelve types the snapshot does NOT carry are a NULL branch, named:
--     subgroups, transport segments, disruptions, the derived commitment and
--     free-window events and the opportunity event are not §22.1 fields —
--     trip_snapshot_seed does not read them either, so folding them would
--     make a seed-replay and a snapshot-replay disagree about what a
--     snapshot contains. Explicit, so the decision is visible.
--
-- Rehearsed on scripts/local-db (apply, then the pipeline's verify + tamper
-- suite and a fresh build from the baseline).

DO $tx$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_snapshot_fold' AND p.pronargs = 2;
  IF d IS NULL THEN RAISE EXCEPTION '2787: trip_snapshot_fold(jsonb, jsonb) not found; the installed kernel is missing 2773'; END IF;
  before_len := length(d);
  IF position('trip.plan_started' in d) > 0 THEN
    RAISE EXCEPTION '2787: the fold already names trip.plan_started; this migration is not idempotent by design';
  END IF;

  -- 1. plan_started / plan_skipped fold status like the other plan-status events
  n := (length(d) - length(replace(d, E'    WHEN t IN (''trip.plan_updated'',''trip.plan_moved'',''trip.plan_confirmed'',\n               ''trip.plan_cancelled'',''trip.plan_completed'') THEN', ''))) / length(E'    WHEN t IN (''trip.plan_updated'',''trip.plan_moved'',''trip.plan_confirmed'',\n               ''trip.plan_cancelled'',''trip.plan_completed'') THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2787: anchor plan-status branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN t IN (''trip.plan_updated'',''trip.plan_moved'',''trip.plan_confirmed'',\n               ''trip.plan_cancelled'',''trip.plan_completed'') THEN',
                  E'    WHEN t IN (''trip.plan_updated'',''trip.plan_moved'',''trip.plan_confirmed'',\n               ''trip.plan_cancelled'',''trip.plan_completed'',\n               ''trip.plan_started'',''trip.plan_skipped'') THEN');

  -- 2. stage_started / stage_completed fold state
  n := (length(d) - length(replace(d, E'    WHEN t = ''trip.stage_removed'' THEN', ''))) / length(E'    WHEN t = ''trip.stage_removed'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2787: anchor stage_removed branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN t = ''trip.stage_removed'' THEN',
$b$    WHEN t IN ('trip.stage_started','trip.stage_completed') THEN
      k := res->>'id';
      cur := coalesce(s->'stages'->k, '{}'::jsonb);
      s := jsonb_set(s, ARRAY['stages', k], cur || jsonb_strip_nulls(jsonb_build_object('state', res->>'state')));
    WHEN t = 'trip.stage_removed' THEN$b$);

  -- 3. the twelve the snapshot does not carry, said out loud
  n := (length(d) - length(replace(d, E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;', ''))) / length(E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;');
  IF n <> 1 THEN RAISE EXCEPTION '2787: anchor plan no-op branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;',
$b$    WHEN t IN ('trip.plan_reordered','trip.plan_route_stop_linked') THEN
      NULL;
    WHEN t IN ('trip.subgroup_created','trip.subgroup_joined','trip.subgroup_left','trip.subgroup_dissolved',
               'trip.transport_segment_added','trip.transport_segment_updated','trip.transport_segment_state_changed','trip.transport_segment_removed',
               'trip.trip_disrupted','trip.disruption_resolved',
               'trip.commitment_at_risk','trip.commitment_risk_cleared','trip.free_window_created',
               'trip.opportunities_changed') THEN
      NULL;  -- §22.1 carries none of these; trip_snapshot_seed reads none of them (2787)$b$);

  EXECUTE d;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2787: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_snapshot_fold' AND p.pronargs = 2;
  FOREACH t IN ARRAY ARRAY['trip.plan_started','trip.plan_skipped','trip.stage_started','trip.stage_completed',
                           'trip.subgroup_created','trip.subgroup_joined','trip.subgroup_left','trip.subgroup_dissolved',
                           'trip.transport_segment_added','trip.transport_segment_updated','trip.transport_segment_state_changed','trip.transport_segment_removed',
                           'trip.trip_disrupted','trip.disruption_resolved','trip.commitment_at_risk','trip.commitment_risk_cleared',
                           'trip.free_window_created','trip.opportunities_changed',
                           'trip.plan_completed','trip.stage_removed','trip.created','trip.risk_added'] LOOP
    IF position('''' || t || '''' in d) = 0 THEN RAISE EXCEPTION '2787: % is not named in the fold', t; END IF;
  END LOOP;
  -- the seed still starts every fold; a stage started folds to 'active'
  IF (public.trip_snapshot_fold(
        '{"stages": {"s1": {"state": "planned"}}, "plans": {}}'::jsonb,
        '{"type": "trip.stage_started", "aggregate_version": 3, "payload_json": {"payload": {"stage_id": "s1"}, "result": {"id": "s1", "state": "active"}}}'::jsonb
      )->'stages'->'s1'->>'state') IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '2787: a started stage did not fold to active';
  END IF;
  IF (public.trip_snapshot_fold(
        '{"stages": {}, "plans": {"p1": {"status": "confirmed"}}}'::jsonb,
        '{"type": "trip.plan_skipped", "aggregate_version": 4, "payload_json": {"payload": {"item_id": "p1"}, "result": {"id": "p1", "status": "skipped"}}}'::jsonb
      )->'plans'->'p1'->>'status') IS DISTINCT FROM 'skipped' THEN
    RAISE EXCEPTION '2787: a skipped plan did not fold to skipped';
  END IF;
  IF (public.trip_snapshot_fold('{"stages": {}, "plans": {}}'::jsonb,
        '{"type": "trip.opportunities_changed", "aggregate_version": 5, "payload_json": {"payload": {"window_id": "w"}, "result": {}}}'::jsonb)) ? 'unfolded' THEN
    RAISE EXCEPTION '2787: an opportunity event still lands in unfolded';
  END IF;
END
$post$;
