-- Rollback for 3601_rent_buddy_commission_basis_points.sql
-- Written 2026-10-08 by lane P (PR #616). Rehearsed only on PGlite (WASM
-- PostgreSQL) with the forward files; NOT run against portava-ci
-- (hwokxgbmezheskbzskfr) or production (ajrurzioarfkagpuxfnb); 3601 itself is
-- applied to neither.
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-08-3601-rent-buddy-commission-basis-points-rollback.sql
--
-- ORDER. Roll back 3603, then 3602, then this file (the reverse of the apply
-- order). 3602's row for `standard` is 3602's to remove; this file does not
-- touch it (the row keeps its `platform_fee_percent` = 10 and outlives the
-- column drop). Deploy an API that does NOT select `platform_fee_basis_points`
-- FIRST: against the #616 code, `resolveFeeSchedule` fails 42703 once the column
-- is gone and every fee-dependent route REFUSES (`read_failed`) — fail-closed,
-- never priced at a default, but every estimate screen errors until then.
--
-- WHAT 3601 DID (as revised by lead ruling P-6, 2026-10-08: no approval column,
-- no approval CHECK)
-- =============
--   * rent_buddy_fee_rules: ADD platform_fee_basis_points (backfilled percent x
--     100, then every row set to 1000, then NOT NULL) and CHECK
--     rbfr_basis_points_range; the legacy platform_fee_percent mirror was set to
--     ROUND(bps / 100); comments on the two columns.
--   * rent_buddy_earnings_ledger: ADD platform_fee_basis_points (nullable) and
--     CHECK rbel_basis_points_range; a comment on it.
--
-- WHAT THIS ROLLBACK CANNOT UNDO
-- ==============================
-- 3601's own UPDATEs overwrote every schedule row's rate with the flat 10 %
-- (the legacy 25 / 22 / 15 / 12 / 12 percents, if they were there). Those
-- values were not recorded anywhere and this file does not invent them: after
-- it, the schedule rows keep platform_fee_percent = 10, the owner's decided
-- rate (OD-PAY-3), which is what the pre-3601 code then prices from.
--
-- WHAT WOULD BE LOST, AND WHY THIS REFUSES INSTEAD
-- ================================================
-- Dropping the columns is lossless only while every value they hold is also
-- carried EXACTLY by the integer percent beside it. So this refuses while:
--   (a) a schedule row's basis points are not exactly its percent x 100 — a
--       fractional rate (e.g. 1050) would survive only as a rounded mirror
--       (11), i.e. a price nobody set;
--   (b) an earnings-ledger row's basis points are not exactly its percent x 100
--       (or its percent is NULL) — the only lossless record of the rate that
--       row was computed under would be destroyed.
-- With none of those, every dropped value is recoverable from the percent
-- column, and the rollback proceeds.

BEGIN;

DO $$
DECLARE
  has_rules_bps   boolean;
  has_ledger_bps  boolean;
  bad             text;
BEGIN
  IF to_regclass('public.rent_buddy_fee_rules') IS NULL OR to_regclass('public.rent_buddy_earnings_ledger') IS NULL THEN
    RAISE EXCEPTION '3601 rollback REFUSED: rent_buddy_fee_rules or rent_buddy_earnings_ledger does not exist; this is not a database 3601 ran on.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_earnings_ledger'::regclass
                   AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped)
    INTO has_rules_bps, has_ledger_bps;

  IF NOT (has_rules_bps OR has_ledger_bps) THEN
    RAISE EXCEPTION '3601 rollback REFUSED: neither of 3601''s basis-point columns exists; there is nothing to roll back (already rolled back, or 3601 never ran).';
  END IF;

  -- (a) a schedule rate the integer percent cannot carry exactly.
  IF has_rules_bps THEN
    EXECUTE $q$
      SELECT string_agg(format('%s (bps %s, percent %s)', buddy_level, platform_fee_basis_points, platform_fee_percent), ', ' ORDER BY buddy_level)
        FROM public.rent_buddy_fee_rules
       WHERE platform_fee_basis_points IS DISTINCT FROM platform_fee_percent * 100
    $q$ INTO bad;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '3601 rollback REFUSED: schedule rate(s) not exactly representable as the percent beside them: %. The rollback would leave only the rounded mirror, a price nobody set.', bad;
    END IF;
  END IF;

  -- (b) a ledger row whose recorded rate exists only in basis points.
  IF has_ledger_bps THEN
    EXECUTE $q$
      SELECT format('%s row(s), e.g. booking %s (bps %s, percent %s)', count(*) OVER (), booking_id, platform_fee_basis_points, platform_fee_percent)
        FROM public.rent_buddy_earnings_ledger
       WHERE platform_fee_basis_points IS NOT NULL
         AND platform_fee_basis_points IS DISTINCT FROM platform_fee_percent * 100
       LIMIT 1
    $q$ INTO bad;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '3601 rollback REFUSED: earnings-ledger rows record a rate the integer percent does not carry exactly: %. Dropping the column destroys the only lossless record of the rate those rows were computed under.', bad;
    END IF;
  END IF;
END $$;

ALTER TABLE public.rent_buddy_fee_rules
  DROP CONSTRAINT IF EXISTS rbfr_basis_points_range;
ALTER TABLE public.rent_buddy_fee_rules
  DROP COLUMN IF EXISTS platform_fee_basis_points;
COMMENT ON COLUMN public.rent_buddy_fee_rules.platform_fee_percent IS NULL; -- the baseline carries no comment on it

ALTER TABLE public.rent_buddy_earnings_ledger
  DROP CONSTRAINT IF EXISTS rbel_basis_points_range;
ALTER TABLE public.rent_buddy_earnings_ledger
  DROP COLUMN IF EXISTS platform_fee_basis_points;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3601_rent_buddy_commission_basis_points.sql';
  END IF;
END $$;

-- ── Postconditions: the pre-3601 schema, exactly ────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
               AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: rent_buddy_fee_rules.platform_fee_basis_points still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_earnings_ledger'::regclass
               AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: rent_buddy_earnings_ledger.platform_fee_basis_points still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('rbfr_basis_points_range', 'rbel_basis_points_range')
               AND conrelid IN ('public.rent_buddy_fee_rules'::regclass, 'public.rent_buddy_earnings_ledger'::regclass)) THEN
    RAISE EXCEPTION '3601 rollback FAILED: a 3601 range CHECK is still present';
  END IF;
  -- The percent column the pre-3601 code prices from is intact and NOT NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'platform_fee_percent' AND attnotnull AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: rent_buddy_fee_rules.platform_fee_percent is missing or nullable';
  END IF;
  RAISE NOTICE '3601 rollback OK: both basis-point columns and their range CHECKs are gone; every dropped value was exactly carried by platform_fee_percent. Schedule rows keep the flat 10 %%.';
END
$post$;

COMMIT;
