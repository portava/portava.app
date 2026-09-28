-- Rollback for 2921_creator_earning_entries.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2921 DID
-- =============
-- Created public.creator_earning_entries (append-only creator earnings: six
-- indexes, RLS on, service_role INSERT/SELECT/DELETE only), the trigger function
-- public.creator_earning_requires_recorded_value_event() and two triggers
-- (cee_requires_recorded_value_event, cee_no_update). It had no rollback file and
-- no reversal note (owner approval request §4, P2).
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- A TRUE ROLLBACK DESTROYS FINANCIAL RECORDS once any row exists, so this file
-- REFUSES while the table holds a row (retention: W10D-B0 / C-11). It refuses
-- while creator_attribution_enabled (2922) is TRUE: the owner has turned the
-- writer on, and dropping its table would fail every write. It refuses while a
-- later file builds on the table: 3385 (creator_share_ledger reads it) or 3387
-- (its triggers and creator_ledger_append). Roll those back first, newest first.
-- Otherwise it drops the table (triggers and indexes go with it), then the trigger
-- function, and deletes 2921's ledger row. 2920's creator_attributions is kept.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'creator_attribution_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2921): creator_attribution_enabled is TRUE; its writer books into this table. Turn it off deliberately first.';
  END IF;
  IF to_regprocedure('public.creator_ledger_append(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2921): 3387 is applied (creator_ledger_append and its triggers are built on this table). Roll 3387 back first.';
  END IF;
  IF to_regclass('public.creator_share_ledger') IS NOT NULL THEN  -- nested: plpgsql does not short-circuit AND, and the cast needs the view
    IF pg_get_viewdef('public.creator_share_ledger'::regclass) LIKE '%creator_earning_entries%' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2921): creator_share_ledger reads this table, so 3385 is applied. Roll 3385 back first.';
    END IF;
  END IF;
  IF to_regclass('public.creator_earning_entries') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.creator_earning_entries' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2921): creator_earning_entries holds % earnings row(s). Dropping it would destroy financial records; what happens to them is the owner''s retention decision (W10D-B0 / C-11). Nothing has been changed.', n;
    END IF;
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public.creator_earning_entries;
DROP FUNCTION IF EXISTS public.creator_earning_requires_recorded_value_event();

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2921_creator_earning_entries.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.creator_earning_entries') IS NOT NULL
     OR to_regprocedure('public.creator_earning_requires_recorded_value_event()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2921 rollback): a 2921 object still exists.';
  END IF;
  IF to_regclass('public.creator_attributions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2921 rollback): 2920''s creator_attributions is gone.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2921_creator_earning_entries.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2921 rollback): the ledger still records 2921 as applied.';
  END IF;
END $post$;
