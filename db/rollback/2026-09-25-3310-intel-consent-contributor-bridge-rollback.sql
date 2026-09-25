-- Rollback for 3310_intel_consent_contributor_bridge.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- 3310 itself has not been applied to any database either, nor has 3002, the
-- migration it bridges; this file exists so the forward change is reviewable as
-- a pair, which is what "reviewed migration" means in §22.
--
-- WHAT 3310 DID
-- =============
--   * CREATE FUNCTION public.intel_consented_contributor_tokens(uuid[])
--       -> the subset of the supplied contributor ids that currently hold
--          enabled, un-withdrawn intel_contribution_consent, computed across
--          every live pepper epoch
--   * CREATE FUNCTION public.intel_contributor_tokens_for_actor(uuid)
--       -> every live-epoch contributor token for an account the caller already
--          holds (the read-only, all-epochs sibling of 3002's
--          intel_contributor_token)
--   * GRANT EXECUTE on both to service_role; REVOKE from PUBLIC/anon/authenticated
--
-- It created no table, wrote no row, altered no column, added no policy and
-- changed no grant on any table. So this reversal is COMPLETE, and it is two
-- DROPs.
--
-- ── WHAT REVERSING IT COSTS, STATED SO NOBODY DISCOVERS IT AT 3AM ──────────
-- On a database that does NOT have 3002 applied, dropping these functions
-- changes nothing observable: the callers probe for the bridge, find it absent,
-- ALSO find 3002's intel_contributor_token absent, conclude the store is not
-- tokenised, and read intel_contribution_consent by account id — which is the
-- correct answer there.
--
-- On a database that DOES have 3002 applied, dropping these functions puts the
-- callers into the one state they are built to refuse:
--
--   lib/intelProjectionAggregator   evidenceComplete = false on every claim;
--                                   nothing projects, nothing is published,
--                                   and no suppression is published either
--   lib/crowdFlowProducer           familyRefusals.next_stop_contribution =
--                                   'consent_unreadable'; the family feeds
--                                   nothing, so no flow bucket can publish
--   lib/intelEvidenceCapture        media evidence is refused with db_error
--                                   (retryable), never 'unknown_observation'
--   services/media/MediaContributorReputationService
--                                   reputation degrades to the empty, zero
--                                   reputation
--
-- THAT IS THE DESIGNED DEGRADATION AND IT IS THE POINT: without the bridge
-- nothing outside the database can map a contributor token to an account, so
-- "who consented" is genuinely UNKNOWN, and publishing an empty cohort as a
-- fact is the defect 3310 exists to remove. DO NOT "restore service" by
-- re-pointing those readers at intel_contribution_consent.user_id — post-3002
-- that join matches nothing and returns SILENTLY EMPTY, which is the
-- indistinguishable-from-nobody-consented failure itself.
--
-- The honest ways out are: re-apply 3310, or roll back 3002 as well
-- (db/rollback/2026-09-25-3002-intel-contribution-identity-rollback.sql, which
-- is partial by construction — read its header first).
--
-- Idempotent: both statements are IF EXISTS.

BEGIN;

DROP FUNCTION IF EXISTS public.intel_consented_contributor_tokens(uuid[]);
DROP FUNCTION IF EXISTS public.intel_contributor_tokens_for_actor(uuid);

-- ── Postcondition ───────────────────────────────────────────────────────────
-- A rollback that half-ran would leave the callers believing the bridge is
-- available while one half of it is gone, so both absences are asserted.
DO $post$
BEGIN
  IF to_regprocedure('public.intel_consented_contributor_tokens(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.intel_consented_contributor_tokens(uuid[]) still exists.';
  END IF;
  IF to_regprocedure('public.intel_contributor_tokens_for_actor(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.intel_contributor_tokens_for_actor(uuid) still exists.';
  END IF;
  -- 3002's own objects are NOT touched here. Dropping the pepper is what makes
  -- existing contributions permanently unerasable; that decision belongs to
  -- 3002's rollback, which refuses it while tokenised rows survive.
  IF to_regclass('public.intel_contributor_pepper') IS NULL THEN
    RAISE NOTICE '3310 rollback: intel_contributor_pepper is absent, so 3002 is not applied here and this rollback changed nothing observable.';
  END IF;
END $post$;

COMMIT;
