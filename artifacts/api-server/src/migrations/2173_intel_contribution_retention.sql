-- 2173_intel_contribution_retention.sql
-- 180-day age-based retention for actor-linked intel CONTRIBUTIONS, plus its flag.
-- DISABLED by default.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- lib/locationPurposes.ts declares the `intel_claim` purpose (lawfulBasis
-- "consent") with a RULED 180-day identifiable retention (owner, 2026-08-23), and
-- says so plainly:
--   "NOT YET ENFORCED: nothing sweeps intel_observations today; ... This entry is
--    the policy, not yet the behaviour. ... a retention policy nobody implements
--    has the same shape as no policy at all."
-- This migration makes the 180 days technically true. 2133 already sweeps the
-- DERIVED aggregate (intel_state_snapshots) by its own TTL; this sweeps the
-- ACTOR-LINKED RAW CONTRIBUTION tables by age.
--
-- ── WHAT IS SWEPT ────────────────────────────────────────────────────────────
-- The three tables the `intel_claim` purpose lists — the only intel tables that
-- carry an actor_id: intel_observations, intel_evidence, intel_confirmations.
-- Each is DELETEd where created_at (the storage instant, timezone-absolute) is
-- older than the caller-supplied cutoff. The scheduler passes now() - 180 days.
--
-- ── WHY DELETE, NOT ANONYMISE ────────────────────────────────────────────────
-- The ruling: "past 180 days the useful claim may be preserved ONLY if contributor
-- identity can be severed; where it cannot be severed, the row is erased." These
-- tables are APPEND-ONLY (2130): the trigger permits DELETE under an explicit
-- erasure declaration but NEVER UPDATE ("Corrections are new rows"). Identity
-- therefore cannot be severed in place, so the ruled fallback applies — the row is
-- erased. The intelligence survives in the DERIVED claims/snapshots (a separate
-- purpose, governed by their own TTL), which carry no actor and are recomputable.
--
-- ── WHAT DELIBERATELY IS NOT SWEPT ───────────────────────────────────────────
-- intel_claims / intel_state_snapshots — DERIVED, no actor column, aggregate
-- beliefs about a place, governed by the freshness-registry TTL and 2133. Nothing
-- else. This function touches only the three actor-linked contribution tables.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
-- Flag-gated, default OFF, fail-closed (same idiom as 2133 / the retention
-- scheduler). Idempotent: a second run over the same cutoff deletes nothing new.
-- Uses the SINGLE sanctioned deletion mechanism (portava.erasure_in_progress),
-- so it is fully compatible with erase_intel_for_actor(). Referential integrity
-- is preserved: children are deleted before parents, and deleting an aged
-- observation cascades (observation_id ON DELETE CASCADE) to any straggler
-- evidence, leaving no actor-identifying orphan.

BEGIN;

-- Age-based erasure of actor-linked contributions older than p_cutoff.
-- p_cutoff is passed in (the scheduler computes now() - 180 days) so the 180-day
-- boundary is deterministic and unit-testable without mocking the clock. Because
-- created_at and p_cutoff are both timestamptz, the comparison is an absolute
-- instant comparison — timezone-independent by construction.
CREATE OR REPLACE FUNCTION public.purge_intel_contributions_older_than(p_cutoff timestamptz)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_cutoff IS NULL THEN
    RAISE EXCEPTION 'purge_intel_contributions_older_than: cutoff is required';
  END IF;

  -- Declare the erasure so the append-only triggers permit DELETE, scoped to this
  -- transaction only. Same mechanism as erase_intel_for_actor().
  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  DELETE FROM public.intel_evidence WHERE created_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE created_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  -- Deleting an aged observation cascades (intel_evidence.observation_id
  -- ON DELETE CASCADE) to any remaining evidence of that observation, so no
  -- evidence is orphaned to a purged parent.
  DELETE FROM public.intel_observations WHERE created_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_intel_contributions_older_than(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_intel_contributions_older_than(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.purge_intel_contributions_older_than(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_intel_contributions_older_than(timestamptz) TO service_role;

COMMENT ON FUNCTION public.purge_intel_contributions_older_than(timestamptz) IS
  'Enforces the ruled 180-day identifiable retention for the intel_claim purpose. Deletes intel_evidence, intel_confirmations and intel_observations whose created_at is older than p_cutoff, using the portava.erasure_in_progress declaration so the append-only triggers permit DELETE. Derived claims/snapshots (no actor) are untouched. Idempotent; compatible with erase_intel_for_actor(). The scheduler passes now() - 180 days.';

-- The switch for the contribution retention sweep. DELETE of contributor data is
-- IRREVERSIBLE, so it gets its OWN flag — independent of intel_retention_sweep_enabled
-- (which governs only the recomputable snapshot hygiene sweep) — and is seeded OFF.
-- Name ends in `_enabled` -> the flag-polarity checker auto-classifies it CAPABILITY,
-- read via isFlagEnabled (on = perform the sweep), which is how the scheduler reads it.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_contribution_retention_enabled',
    false,
    'Enables the daily 180-day age-based deletion of actor-linked intel contributions (intel_observations/intel_evidence/intel_confirmations) via purge_intel_contributions_older_than(). Off means the ruled 180-day retention is NOT enforced. Independent of intel_retention_sweep_enabled (snapshot hygiene). Irreversible deletion — enable deliberately.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_contribution_retention_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contribution_retention_enabled not present after seed';
  END IF;
  IF to_regprocedure('public.purge_intel_contributions_older_than(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: purge_intel_contributions_older_than is missing';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_contribution_retention_enabled';
--   DROP FUNCTION IF EXISTS public.purge_intel_contributions_older_than(timestamptz);
-- Rows already swept are not recoverable, but past 180 days they were due for erasure.
