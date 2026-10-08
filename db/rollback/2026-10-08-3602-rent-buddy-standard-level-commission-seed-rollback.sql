-- Rollback for 3602_rent_buddy_standard_level_commission_seed.sql
-- Written 2026-10-08 by lane P (PR #616). NOT rehearsed on a database: this
-- machine has no PostgreSQL. NOT run against portava-ci (hwokxgbmezheskbzskfr)
-- or production (ajrurzioarfkagpuxfnb); 3602 itself is applied to neither.
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-08-3602-rent-buddy-standard-level-commission-seed-rollback.sql
--
-- ORDER. After 3603's rollback (independent) and BEFORE 3601's: this file reads
-- 3601's columns to recognise 3602's row.
--
-- WHAT 3602 DID
-- =============
--   INSERT INTO rent_buddy_fee_rules (buddy_level, platform_fee_basis_points, platform_fee_percent)
--   VALUES ('standard', 1000, 10) ON CONFLICT (buddy_level) DO NOTHING;
--   and a COMMENT ON TABLE rent_buddy_fee_rules (the baseline carries none).
--
-- WHY THIS CAN ONLY RECOGNISE 3602'S ROW BY ITS VALUES
-- ====================================================
-- 3602 knew whether `standard` already existed only through an ON COMMIT DROP
-- temp table, so nothing on the database records whether the row there now is
-- the one 3602 inserted or an operator's. This file therefore deletes the row
-- ONLY while it carries EXACTLY the seeded values — basis points 1000, percent
-- 10, no override approval, traveller service fee 0 / 0 — and REFUSES otherwise:
-- a row with any other value is an operator's later (or earlier) pricing
-- decision, and deleting it would destroy that decision. A row identical to the
-- seed is treated as the seed; deleting it returns `standard` to "unpriced",
-- which is exactly the state 3602 changed (its own header: "a legitimate state
-- to return to").
--
-- CONSEQUENCE AN OPERATOR MUST KNOW. With no schedule row, every fee route for a
-- `standard` buddy refuses (`no_such_level`) again — estimates, and the earnings
-- ledger write at completion, for any open booking of such a buddy. Ledger rows
-- already written keep the rate they recorded (3601's column); nothing here
-- alters them.

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.rent_buddy_fee_rules') IS NULL THEN
    RAISE EXCEPTION '3602 rollback REFUSED: public.rent_buddy_fee_rules does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
                   AND attname = 'commission_override_approval' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION '3602 rollback REFUSED: 3601''s columns are absent, so 3602''s row cannot be recognised. Roll back 3602 BEFORE 3601.';
  END IF;

  SELECT buddy_level, platform_fee_basis_points, platform_fee_percent, commission_override_approval,
         traveler_service_fee_usd, traveler_service_fee_pct
    INTO r
    FROM public.rent_buddy_fee_rules WHERE buddy_level = 'standard';

  IF NOT FOUND THEN
    RAISE NOTICE '3602 rollback: there is no ''standard'' row; nothing to delete.';
  ELSIF r.platform_fee_basis_points IS DISTINCT FROM 1000
     OR r.platform_fee_percent IS DISTINCT FROM 10
     OR r.commission_override_approval IS NOT NULL
     OR r.traveler_service_fee_usd IS DISTINCT FROM 0
     OR r.traveler_service_fee_pct IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '3602 rollback REFUSED: the ''standard'' row is not the one 3602 seeds (bps %, percent %, approval %, service fee usd % / pct %). It is an operator''s pricing decision; deleting it would destroy that decision.',
      r.platform_fee_basis_points, r.platform_fee_percent, coalesce(r.commission_override_approval, '<null>'),
      r.traveler_service_fee_usd, r.traveler_service_fee_pct;
  END IF;
END $$;

DELETE FROM public.rent_buddy_fee_rules
 WHERE buddy_level = 'standard'
   AND platform_fee_basis_points = 1000
   AND platform_fee_percent = 10
   AND commission_override_approval IS NULL
   AND traveler_service_fee_usd = 0
   AND traveler_service_fee_pct = 0;

COMMENT ON TABLE public.rent_buddy_fee_rules IS NULL; -- the baseline carries no table comment

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3602_rent_buddy_standard_level_commission_seed.sql';
  END IF;
END $$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.rent_buddy_fee_rules WHERE buddy_level = 'standard') THEN
    RAISE EXCEPTION '3602 rollback FAILED: a ''standard'' schedule row still exists';
  END IF;
  RAISE NOTICE '3602 rollback OK: ''standard'' is unpriced again (its fee routes refuse with no_such_level); no other level was touched.';
END
$post$;

COMMIT;
