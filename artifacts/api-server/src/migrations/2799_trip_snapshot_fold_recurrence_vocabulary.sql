-- 2799_trip_snapshot_fold_recurrence_vocabulary.sql
--
-- Trips spec §22.1 / §22.2 — the snapshot fold must name every event the kernel
-- emits, and 2798 added five it does not know. 2787 is the precedent and its
-- header states the failure mode exactly: an event the fold does not name is
-- met with `unfolded`, the replay still agrees with ITSELF, and the snapshot is
-- quietly wrong about the fields those events change.
--
-- WHAT THE FOLD DOES WITH A RECURRENCE EVENT: NOTHING, EXPLICITLY
-- ==============================================================
-- §22.1's TripSnapshot is
--   { tripId aggregateVersion lifecycleState stageId activePlanId?
--     nextCommitmentId? freeWindowSummary crewSummary riskSummary sourceRefs
--     engineVersions createdAt }
-- and a recurrence RULE is none of those. In particular it is not
-- `nextCommitmentId`: an occurrence of a rule has no `trip_commitments` row and
-- therefore no id a snapshot could carry — which is the whole point of 2797 and
-- is why this is a decision rather than an omission.
--
-- `trip_snapshot_seed` does not read trip_commitment_recurrences either, so
-- folding these events would make a seed-replay and a snapshot-replay disagree
-- about what a snapshot contains — 2787's stated reason for the twelve types it
-- put in the same branch. The five are added THERE, named, so the decision is
-- visible in the function rather than inferable from its absence.
--
-- WHY THE ANCHOR IS 2773'S AND NOT 2787'S
-- =======================================
-- The two-line plan no-op branch this file anchors on is present in the fold
-- BOTH before and after 2787 (2787's replacement re-emits it verbatim as its
-- first two lines), so this migration applies to either. Anchoring on 2787's
-- own block would have made this file refuse on a database that has 2773 and
-- not 2787, for no reason: nothing here depends on 2787.
--
-- NO ROLLBACK FILE, matching 2787: the fold is withdrawn whole by
-- db/rollback/2026-09-09-2773-trip-snapshot-fold-and-replay-rollback.sql, and
-- an inverse transform that removes a NULL branch removes nothing a caller can
-- observe — it would only move these five types from "named as not carried"
-- back to "counted under unfolded".
--
-- Rehearsed on db/harness/run.sh (db/harness/probe_recurrence_fold.sql), which
-- FOLDS a real recurrence event and asserts it does not land in `unfolded`.

BEGIN;

DO $tx$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_snapshot_fold' AND p.pronargs = 2;
  IF d IS NULL THEN RAISE EXCEPTION '2799: trip_snapshot_fold(jsonb, jsonb) not found; apply 2773 first'; END IF;
  before_len := length(d);
  IF position('trip.recurring_commitment_added' in d) > 0 THEN
    RAISE EXCEPTION '2799: the fold already names the recurrence vocabulary; this migration is not idempotent by design';
  END IF;

  n := (length(d) - length(replace(d, E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;', ''))) / length(E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;');
  IF n <> 1 THEN RAISE EXCEPTION '2799: anchor plan no-op branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN t IN (''trip.plan_reordered'',''trip.plan_route_stop_linked'') THEN\n      NULL;',
$b$    WHEN t IN ('trip.plan_reordered','trip.plan_route_stop_linked') THEN
      NULL;
    WHEN t IN ('trip.recurring_commitment_added','trip.recurring_commitment_updated',
               'trip.recurring_commitment_removed','trip.recurrence_occurrence_skipped',
               'trip.recurrence_occurrence_restored') THEN
      NULL;  -- §22.1 carries no recurrence field, and an occurrence has no id (2797/2799)$b$);

  IF length(d) <= before_len THEN RAISE EXCEPTION '2799: the definition did not grow'; END IF;
  EXECUTE d;
END
$tx$;

DO $post$
DECLARE d text; t text; folded jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_snapshot_fold' AND p.pronargs = 2;

  FOREACH t IN ARRAY ARRAY['trip.recurring_commitment_added','trip.recurring_commitment_updated',
                           'trip.recurring_commitment_removed','trip.recurrence_occurrence_skipped',
                           'trip.recurrence_occurrence_restored'] LOOP
    IF position('''' || t || '''' in d) = 0 THEN RAISE EXCEPTION '2799: % is not named in the fold', t; END IF;
  END LOOP;

  -- BEHAVIOUR, not presence: fold each of the five and require that none of
  -- them reaches `unfolded` and none of them changes the state. A NULL branch
  -- that accidentally fell into a neighbouring one would pass the loop above.
  FOREACH t IN ARRAY ARRAY['trip.recurring_commitment_added','trip.recurring_commitment_updated',
                           'trip.recurring_commitment_removed','trip.recurrence_occurrence_skipped',
                           'trip.recurrence_occurrence_restored'] LOOP
    folded := public.trip_snapshot_fold(
      '{"stages": {"s1": {"state": "active"}}, "plans": {"p1": {"status": "confirmed"}}}'::jsonb,
      jsonb_build_object('type', t, 'aggregate_version', 9,
        'payload_json', jsonb_build_object('payload', jsonb_build_object('recurrence_id','r1'),
                                           'result',  jsonb_build_object('id','r1'))));
    IF folded ? 'unfolded' THEN
      RAISE EXCEPTION '2799: % still lands in unfolded', t;
    END IF;
    -- The two collections must be untouched. (The fold appends DERIVED fields
    -- — stage_id, active_plan_id, next_commitment_id — to every state it
    -- returns, so the whole object is not comparable; the collections are.)
    IF folded->'stages' IS DISTINCT FROM '{"s1": {"state": "active"}}'::jsonb
       OR folded->'plans' IS DISTINCT FROM '{"p1": {"status": "confirmed"}}'::jsonb THEN
      RAISE EXCEPTION '2799: % changed the snapshot state; it must be a no-op', t;
    END IF;
  END LOOP;

  -- The vocabulary this file did not name must still be named. 2773's own
  -- branches and 2787's are the ones a careless replacement would have eaten.
  FOREACH t IN ARRAY ARRAY['trip.plan_reordered','trip.plan_route_stop_linked',
                           'trip.commitment_added','trip.stage_removed','trip.created','trip.risk_added'] LOOP
    IF position('''' || t || '''' in d) = 0 THEN RAISE EXCEPTION '2799: % was lost', t; END IF;
  END LOOP;

  -- An unknown type must STILL be counted; 2773's guarantee is not this file's
  -- to relax.
  IF NOT (public.trip_snapshot_fold('{"stages": {}, "plans": {}}'::jsonb,
            '{"type": "trip.not_a_real_event", "aggregate_version": 1, "payload_json": {"payload": {}, "result": {}}}'::jsonb)
          ? 'unfolded') THEN
    RAISE EXCEPTION '2799: an unknown event type is no longer counted under unfolded';
  END IF;
END
$post$;

COMMIT;
