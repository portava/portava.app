-- 2133_intel_retention.sql
-- Retention sweep for the intel tables, plus its flag. DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS EXISTS NOW AND NOT LATER ───────────────────────────────────────
-- location_snapshots carried expires_at for months with nothing to delete the
-- rows: purgeExpiredSnapshots() had exactly one reference in the repository, its
-- own definition, and no cleanup job called it. Readers filtered on expires_at,
-- so the feature looked correct while the data accumulated forever.
-- 2130 gives intel_state_snapshots and intel_observations the same expires_at
-- shape. Shipping the sweeper in the same band as the tables is how that defect
-- does not repeat.
--
-- ── WHAT IS SWEPT, AND WHAT DELIBERATELY IS NOT ─────────────────────────────
-- SWEPT: intel_state_snapshots past expires_at. They are DERIVED and
-- recomputable from claims, so deleting an expired one destroys nothing — and an
-- expired snapshot is already invisible (lib/liveClaimRead.ts filters it out in
-- the query). This is pure hygiene.
--
-- NOT SWEPT: intel_observations. They are contributor content, and how long a
-- report about the world may be kept is a RETENTION POLICY decision, not an
-- engineering default. docs/ops/retention-policy.md sets a 90-day window while
-- the specification's pattern cohorts need 120-180 days from DERIVED aggregates —
-- that tension is an open owner decision. Guessing a number here would quietly
-- destroy contributions under a policy nobody agreed. When the window is set,
-- extend this function; the erasure declaration it already makes will cover it.
--
-- RUNTIME EFFECT: NONE. Seeded false.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_state_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130_intel_storage.sql first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- Declares the erasure even though intel_state_snapshots has no append-only
-- trigger today. If one is ever added, this function keeps working; and the
-- declaration documents that a DELETE here is deliberate retention, not a bug.
CREATE OR REPLACE FUNCTION public.purge_expired_intel_snapshots()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('portava.erasure_in_progress', 'on', true);
  DELETE FROM public.intel_state_snapshots WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_intel_snapshots() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_intel_snapshots() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_intel_snapshots() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_intel_snapshots() TO service_role;

COMMENT ON FUNCTION public.purge_expired_intel_snapshots() IS
  'Deletes intel_state_snapshots past expires_at. Snapshots are derived and recomputable, and an expired one is already invisible to readers, so this is hygiene rather than data loss. Does NOT touch intel_observations — that window is a retention-policy decision.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_retention_sweep_enabled',
    false,
    'Enables the hourly sweep of expired intel_state_snapshots. Off means expired snapshots accumulate (already invisible to readers, but retained). Does not affect intel_observations.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_retention_sweep_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_retention_sweep_enabled not present after seed';
  END IF;
  IF to_regprocedure('public.purge_expired_intel_snapshots()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: purge_expired_intel_snapshots is missing';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_retention_sweep_enabled';
--   DROP FUNCTION IF EXISTS public.purge_expired_intel_snapshots();
-- Rows already swept are not recoverable, but they were expired and unreadable.
