-- Rollback for 2774_trip_proposal_governance.sql
--
-- Drops trip_proposal_votes, the two §9.3 columns and the two functions.
--
-- ORDER: AFTER the 2775 rollback. 2775's kernel calls trip_proposal_tally and
-- reads decision_rule; running this first leaves a kernel that dispatches at a
-- missing function and fails at the first ACCEPT_PROPOSAL. The precondition
-- refuses rather than letting that happen.
--
-- DATA: every vote. There is no other record of who voted which way — the
-- trip_events ledger carries each trip.proposal_voted with its tally at the
-- time, so the HISTORY survives, but the current per-person state does not.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_proposal_votes') IS NULL THEN
    RAISE EXCEPTION 'rollback 2774: not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname='trip_kernel_execute'
                AND position('trip_proposal_tally' in p.prosrc) > 0) THEN
    RAISE EXCEPTION 'rollback 2774: the kernel still calls trip_proposal_tally. Run the 2775 rollback first, or ACCEPT_PROPOSAL will hit a missing function at runtime.';
  END IF;
  SELECT count(*) INTO n FROM public.trip_proposal_votes;
  IF n > 0 THEN
    RAISE WARNING 'rollback 2774: % vote(s) are about to be dropped. The trip_events ledger keeps each vote and its tally at the time; the current per-person state exists only here.', n;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.trip_proposal_tally(uuid);
DROP FUNCTION IF EXISTS public.trip_proposal_electorate(uuid);
DROP TABLE public.trip_proposal_votes;
ALTER TABLE public.trip_proposals DROP CONSTRAINT trip_proposals_decision_rule_known;
ALTER TABLE public.trip_proposals DROP COLUMN decision_rule, DROP COLUMN proposed_by;

DO $post$
DECLARE n int; t text;
BEGIN
  IF to_regclass('public.trip_proposal_votes') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 2774: the votes table survived';
  END IF;
  FOREACH t IN ARRAY ARRAY['decision_rule','proposed_by'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_proposals'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 2774: column % survived', t; END IF;
  END LOOP;
  -- 2763's own columns must be intact.
  FOREACH t IN ARRAY ARRAY['id','trip_id','proposal_type','payload_json','status',
                           'expires_at','affected_version'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_proposals'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2774: 2763 column % was lost', t; END IF;
  END LOOP;
END
$post$;

COMMIT;
