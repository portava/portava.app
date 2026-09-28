-- Rollback for 2901_rent_buddy_earnings_entries.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2901 DID
-- =============
-- Created public.rent_buddy_earnings_entries (append-only double-entry earnings
-- for Rent-a-Buddy bookings: five indexes, the rbee_no_update trigger over the
-- existing intel_append_only(), RLS on, service_role INSERT/SELECT/DELETE only).
-- It had no rollback file and no reversal note (owner approval request §4, P2).
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- A TRUE ROLLBACK DESTROYS FINANCIAL RECORDS once any row exists, so this file
-- REFUSES while the table holds a row. Keeping, anonymising or deleting earnings
-- is the owner's retention question (W10D-B0 / C-11), never a rollback.
-- It also refuses while a later file builds on the table: 2930's
-- creator_share_ledger view, or 3387 (creator_ledger_append, whose one-earning
-- rule reads this table). Roll those back first, newest first.
-- With the table empty and nothing built on it, it drops the table (its trigger
-- and indexes go with it; intel_append_only() is 2130's and is kept) and deletes
-- 2901's ledger row.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.creator_share_ledger') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2901): public.creator_share_ledger (2930) reads this table. Roll 2930 back first.';
  END IF;
  IF to_regprocedure('public.creator_ledger_append(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2901): 3387 is applied (creator_ledger_append reads this table). Roll 3387 back first.';
  END IF;
  IF to_regclass('public.rent_buddy_earnings_entries') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.rent_buddy_earnings_entries' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2901): rent_buddy_earnings_entries holds % earnings row(s). Dropping it would destroy financial records; what happens to them is the owner''s retention decision (W10D-B0 / C-11). Nothing has been changed.', n;
    END IF;
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public.rent_buddy_earnings_entries;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2901_rent_buddy_earnings_entries.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.rent_buddy_earnings_entries') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2901 rollback): rent_buddy_earnings_entries still exists.';
  END IF;
  IF to_regclass('public.rent_buddy_bookings') IS NULL OR to_regprocedure('public.intel_append_only()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2901 rollback): an object 2901 depended on (rent_buddy_bookings, intel_append_only) is gone.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2901_rent_buddy_earnings_entries.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2901 rollback): the ledger still records 2901 as applied.';
  END IF;
END $post$;
