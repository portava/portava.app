-- Rollback for 2289_discovery_ranking_modifiers_flag.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2289 DID
-- =============
-- Inserted ONE row into public.feature_flags, ('discovery_ranking_modifiers_enabled',
-- false, '<description>'), ON CONFLICT (flag) DO NOTHING. Nothing else. Its footer
-- carried a manual reversal (DELETE the row); this file is that reversal, guarded.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- REFUSES while the flag reads TRUE: the owner has turned the step 7/8 modifiers
-- on since 2289, and deleting the row would silently turn them off (an absent row
-- reads false). Otherwise it deletes the row ONLY if 2289 wrote it (its description
-- is 2289's seed text byte for byte, the md5 below; a pre-existing row is kept, as
-- W10-F's flag-seed rule does), then deletes 2289's ledger row. Nothing is lost:
-- a FALSE capability row and an absent one read alike (isFlagEnabled, fail-closed).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_ranking_modifiers_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2289): discovery_ranking_modifiers_enabled is TRUE. Deleting the row would silently turn the Discovery modifiers off. Turn it off deliberately first, then re-run this file.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_ranking_modifiers_enabled'
                AND md5(coalesce(description, '')) <> '1d04e82fac149c479a0ba325888bff40') THEN
    RAISE NOTICE '2289 rollback: discovery_ranking_modifiers_enabled was not written by 2289 (its description is not 2289''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
     WHERE flag = 'discovery_ranking_modifiers_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2289_discovery_ranking_modifiers_flag.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_ranking_modifiers_enabled'
                AND md5(coalesce(description, '')) = '1d04e82fac149c479a0ba325888bff40') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2289 rollback): 2289''s row is still present.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2289_discovery_ranking_modifiers_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2289 rollback): the ledger still records 2289 as applied.';
  END IF;
END $post$;
