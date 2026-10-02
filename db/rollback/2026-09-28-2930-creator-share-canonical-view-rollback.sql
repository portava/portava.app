-- Rollback for 2930_creator_share_canonical_view.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2930 DID
-- =============
-- Created the view public.creator_share_ledger (security_invoker, UNION ALL over
-- intel_reward_ledger and rent_buddy_earnings_entries; SELECT for service_role
-- only) with its comment. No earlier file defines the view. It had no rollback
-- file and no reversal note (owner approval request §4, P2).
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- The view stores nothing, so dropping it loses no row. It refuses while 3385 is
-- applied (the view then also reads creator_earning_entries; 3385's rollback
-- restores 2930's definition, so roll 3385 back first), and while
-- creator_attribution_enabled is TRUE (services/ledger/CanonicalShareReader reads
-- the view). Otherwise it drops the view (no CASCADE: a dependent view makes the
-- DROP fail, which is the point) and deletes 2930's ledger row.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'creator_attribution_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2930): creator_attribution_enabled is TRUE and the canonical share reader reads this view. Turn it off deliberately first.';
  END IF;
  IF to_regclass('public.creator_share_ledger') IS NOT NULL THEN  -- nested: plpgsql does not short-circuit AND, and the cast needs the view
    IF pg_get_viewdef('public.creator_share_ledger'::regclass) LIKE '%creator_earning_entries%' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2930): creator_share_ledger reads creator_earning_entries, so 3385 is applied. Roll 3385 back first.';
    END IF;
  END IF;
END
$pre$;

DROP VIEW IF EXISTS public.creator_share_ledger;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2930_creator_share_canonical_view.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.creator_share_ledger') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2930 rollback): creator_share_ledger still exists.';
  END IF;
  IF to_regclass('public.intel_reward_ledger') IS NULL OR to_regclass('public.rent_buddy_earnings_entries') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2930 rollback): a source ledger of the view is gone.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2930_creator_share_canonical_view.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2930 rollback): the ledger still records 2930 as applied.';
  END IF;
END $post$;
