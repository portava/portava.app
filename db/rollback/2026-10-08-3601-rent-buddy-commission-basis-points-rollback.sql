-- Rollback for 3601_rent_buddy_commission_basis_points.sql
-- Written 2026-10-08 by lane P (PR #616). NOT rehearsed on a database: this
-- machine has no PostgreSQL. NOT run against portava-ci (hwokxgbmezheskbzskfr)
-- or production (ajrurzioarfkagpuxfnb); 3601 itself is applied to neither.
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
-- WHAT 3601 DID
-- =============
--   * rent_buddy_fee_rules: ADD platform_fee_basis_points (backfilled percent x
--     100, then every unapproved row set to 1000, then NOT NULL), ADD
--     commission_override_approval, CHECK rbfr_basis_points_range and CHECK
--     rbfr_flat_rate_unless_approved; the legacy platform_fee_percent mirror was
--     set to ROUND(bps / 100); comments on the three columns.
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
--   (a) a schedule row carries a commission_override_approval — the record of a
--       separately approved override would be destroyed;
--   (b) a schedule row's basis points are not exactly its percent x 100 — an
--       approved fractional rate (e.g. 1050) would survive only as a rounded
--       mirror (11), i.e. a price nobody approved;
--   (c) an earnings-ledger row's basis points are not exactly its percent x 100
--       (or its percent is NULL) — the only lossless record of the rate that
--       row was computed under would be destroyed.
-- With none of those, every dropped value is recoverable from the percent
-- column, and the rollback proceeds.

BEGIN;

DO $$
DECLARE
  has_rules_bps   boolean;
  has_approval    boolean;
  has_ledger_bps  boolean;
  bad             text;
BEGIN
  IF to_regclass('public.rent_buddy_fee_rules') IS NULL OR to_regclass('public.rent_buddy_earnings_ledger') IS NULL THEN
    RAISE EXCEPTION '3601 rollback REFUSED: rent_buddy_fee_rules or rent_buddy_earnings_ledger does not exist; this is not a database 3601 ran on.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'commission_override_approval' AND attnum > 0 AND NOT attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_earnings_ledger'::regclass
                   AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped)
    INTO has_rules_bps, has_approval, has_ledger_bps;

  IF NOT (has_rules_bps OR has_approval OR has_ledger_bps) THEN
    RAISE EXCEPTION '3601 rollback REFUSED: none of 3601''s three columns exists; there is nothing to roll back (already rolled back, or 3601 never ran).';
  END IF;

  -- (a) an approval record would be destroyed.
  IF has_approval THEN
    EXECUTE $q$
      SELECT string_agg(format('%s (%s)', buddy_level, commission_override_approval), ', ' ORDER BY buddy_level)
        FROM public.rent_buddy_fee_rules WHERE commission_override_approval IS NOT NULL
    $q$ INTO bad;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '3601 rollback REFUSED: schedule row(s) carry a commission_override_approval: %. Dropping the column destroys the record of an approved override; remove the override by a reviewed migration first.', bad;
    END IF;
  END IF;

  -- (b) a schedule rate the integer percent cannot carry exactly.
  IF has_rules_bps THEN
    EXECUTE $q$
      SELECT string_agg(format('%s (bps %s, percent %s)', buddy_level, platform_fee_basis_points, platform_fee_percent), ', ' ORDER BY buddy_level)
        FROM public.rent_buddy_fee_rules
       WHERE platform_fee_basis_points IS DISTINCT FROM platform_fee_percent * 100
    $q$ INTO bad;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '3601 rollback REFUSED: schedule rate(s) not exactly representable as the percent beside them: %. The rollback would leave only the rounded mirror, a price nobody approved.', bad;
    END IF;
  END IF;

  -- (c) a ledger row whose recorded rate exists only in basis points.
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
  DROP CONSTRAINT IF EXISTS rbfr_flat_rate_unless_approved,
  DROP CONSTRAINT IF EXISTS rbfr_basis_points_range;
ALTER TABLE public.rent_buddy_fee_rules
  DROP COLUMN IF EXISTS platform_fee_basis_points,
  DROP COLUMN IF EXISTS commission_override_approval;
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
               AND attname IN ('platform_fee_basis_points', 'commission_override_approval') AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: a 3601 column still exists on rent_buddy_fee_rules';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_earnings_ledger'::regclass
               AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: rent_buddy_earnings_ledger.platform_fee_basis_points still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('rbfr_flat_rate_unless_approved', 'rbfr_basis_points_range', 'rbel_basis_points_range')
               AND conrelid IN ('public.rent_buddy_fee_rules'::regclass, 'public.rent_buddy_earnings_ledger'::regclass)) THEN
    RAISE EXCEPTION '3601 rollback FAILED: a 3601 CHECK constraint is still present';
  END IF;
  -- The percent column the pre-3601 code prices from is intact and NOT NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'platform_fee_percent' AND attnotnull AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3601 rollback FAILED: rent_buddy_fee_rules.platform_fee_percent is missing or nullable';
  END IF;
  RAISE NOTICE '3601 rollback OK: both basis-point columns, the approval column and the three CHECKs are gone; every dropped value was exactly carried by platform_fee_percent. Schedule rows keep the flat 10 %%.';
END
$post$;

COMMIT;
