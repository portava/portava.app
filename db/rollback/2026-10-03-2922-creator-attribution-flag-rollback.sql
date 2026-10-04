-- Rollback for 2922_creator_attribution_flag.sql
-- Written 2026-10-03 by the creator-ledger lane, completing the rollback set for
-- the seven-file creator-ledger rollout (2901, 2920, 2921, 2922, 3386, 3387, 3510);
-- 2920 and 2922 were the two with no rollback file.
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh:
-- apply the chain, roll back, re-apply, catalogue diff).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2922 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('creator_attribution_enabled', false, '<seed description>')
--     ON CONFLICT (flag) DO NOTHING.
--   * Nothing else. No table, no column, no index, no constraint, no trigger,
--     no function, no policy, no grant. Its own reversal note reads
--     `DELETE FROM public.feature_flags WHERE flag = 'creator_attribution_enabled';`.
--
-- DELETE THE ROW, NOT RESET IT — AND WHY
-- ======================================
-- The convention for a capability-flag migration in this tree is to DELETE the
-- row it seeded, never to set it back to FALSE: see
-- 2026-09-27-3351-media-find-busier-flag-rollback.sql and
-- 2026-09-28-3496-discovery-w11x3-flags-rollback.sql, both of which delete.
-- The reason is that 2922's whole point was that the row's ABSENCE and the row
-- set to FALSE are byte-identical to every caller (`isFlagEnabled` reads an
-- absent row as false, fail-closed), so what 2922 actually added was the row's
-- EXISTENCE — an operator being able to see the capability and flip it without
-- shipping SQL. Resetting to FALSE would leave that behind and the ledger row
-- deleted, i.e. a flag the applier will re-seed on top of. Deleting restores
-- exactly the pre-2922 state: the phantom flag, which is the defect 2922 fixed,
-- restored on purpose — a rollback returns to the prior state, it does not
-- improve it.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES while creator_attribution_enabled is TRUE: the owner has turned
-- creator attribution on since 2922 was applied, and deleting the row would
-- silently turn the whole subsystem off again (an absent row reads false).
-- Turn it off deliberately first, then re-run this file. 2921's rollback refuses
-- on the same condition, for the same reason.
-- It keeps a row 2922 did not write. 2922 inserts ON CONFLICT (flag) DO NOTHING,
-- so a row that already existed kept its own description; a row whose
-- description is not 2922's seed text byte for byte (the md5 below) was not
-- written by 2922 and is left alone, as 3351's rollback does.
-- It does NOT touch the pre-rename name `creator_attribution`. 2922 renamed the
-- flag in code, but no migration ever seeded a row under the old name (that was
-- the phantom), so there is no row to restore and recreating one would invent a
-- gate nothing reads.
-- Then it deletes 2922's schema_migration_ledger row so the applier re-applies it.
-- Idempotent: safe to re-run after a successful run (every statement is
-- existence-guarded and the postconditions pass on an already-rolled-back
-- database).
--
-- ORDER: this file is independent of the rest of the set — nothing reads the
-- flag in SQL. Rolling the set back newest-first puts it after 2921 and before
-- 2920, which is also the order 2920's rollback is happiest in: 2920 refuses
-- while the flag is TRUE, and a deleted row reads false.

BEGIN;

DO $pre$
DECLARE on_count int;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2922): public.feature_flags does not exist; this is not a database 2922 was applied to.';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'creator_attribution_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (2922): creator_attribution_enabled is TRUE. The owner has turned creator attribution on since 2922 was applied; deleting the row would silently turn it off again (an absent row reads false). Turn it off deliberately first, then re-run this file. Nothing has been changed.';
  END IF;
END
$pre$;

-- Only the row 2922 wrote. The md5 is of 2922's seed description, verbatim.
DO $del$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'creator_attribution_enabled'
                AND md5(coalesce(description, '')) <> 'a70e38418c73f324ec3bf25964df1814') THEN
    RAISE NOTICE '2922 rollback: creator_attribution_enabled was not written by 2922 (its description is not 2922''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'creator_attribution_enabled' AND enabled = FALSE;
  END IF;
END
$del$;

DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2922_creator_attribution_flag.sql';
  END IF;
END
$ledger$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'creator_attribution_enabled'
      AND md5(coalesce(description, '')) = 'a70e38418c73f324ec3bf25964df1814';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2922 rollback): the row 2922 wrote is still present (% row(s)).', present;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'creator_attribution') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2922 rollback): a row exists under the pre-rename name creator_attribution; this file must neither create nor leave one.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2922_creator_attribution_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2922 rollback): the ledger still records 2922 as applied.';
  END IF;
END
$post$;
