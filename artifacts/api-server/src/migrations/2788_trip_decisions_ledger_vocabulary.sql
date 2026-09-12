-- 2788_trip_decisions_ledger_vocabulary.sql
--
-- Trips spec §21.2 — the decision ledger's type vocabulary grows with the
-- engines that write to it. census-trips TR401, TR402 (the ledger), §42
-- (pulse_projection), §43 (opportunity_portfolio, opportunity_projection).
--
-- 2781's CHECK named the three decision types of its day. §42 and §43 added
-- three more, and persistTripDecision (services/trips/TripDecisionLedger.ts)
-- would have had every one of them refused by the CHECK — silently, because
-- the ledger is best-effort by design (the projection is served either way).
-- check:enum-literals caught the read side (`decision_type =
-- 'opportunity_portfolio'` on a column that could not hold it); this file
-- is the write side's answer. The constraint is replaced, not widened in
-- place: a CHECK has no ALTER, and the name stays so 2781's postcondition
-- and every citation of it hold.
--
-- Additive. No rows change. Applied on scripts/local-db; rehearsed by
-- src/test/db/tripOpportunityEvents.db.test.ts inserting each new type and
-- one unknown one.

ALTER TABLE public.trip_decisions DROP CONSTRAINT IF EXISTS trip_decisions_type_known;
ALTER TABLE public.trip_decisions
  ADD CONSTRAINT trip_decisions_type_known
  CHECK (decision_type IN ('freedom_windows', 'trip_health', 'today_projection', 'opportunities', 'meeting_point', 'disruption', 'experience', 'pulse_projection', 'opportunity_portfolio', 'opportunity_projection'));

DO $post$
DECLARE t text; def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'trip_decisions_type_known' AND conrelid = 'public.trip_decisions'::regclass;
  IF def IS NULL THEN RAISE EXCEPTION '2788: trip_decisions_type_known is missing'; END IF;
  FOREACH t IN ARRAY ARRAY['freedom_windows', 'trip_health', 'today_projection', 'opportunities', 'meeting_point', 'disruption', 'experience', 'pulse_projection', 'opportunity_portfolio', 'opportunity_projection'] LOOP
    IF position('''' || t || '''' in def) = 0 THEN RAISE EXCEPTION '2788: % is not in the CHECK', t; END IF;
  END LOOP;
END
$post$;
