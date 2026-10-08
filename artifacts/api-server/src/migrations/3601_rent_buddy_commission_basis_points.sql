-- 3601_rent_buddy_commission_basis_points.sql
--
-- RENUMBERED 3520 -> 3601 on 2026-10-06 (lane P, PR #616). Main took 3520 for
-- 3520_user_stamps_client_column_grants.sql (applied to portava-ci). This file
-- was applied to no database under either number and does not self-register,
-- so nothing that exists moved; every "3601" below that once read "3520" is the
-- same statement about this file. It sorts after 3530 now; 3530 replaces
-- rb_buddy_earnings_summary and names neither table this file alters.
--
-- The Rent-a-Buddy platform commission becomes expressible, and becomes flat.
--
--   * `rent_buddy_fee_rules.platform_fee_basis_points` — the rate, in basis
--     points. 10 % == 1000, on every level.
--   * `rent_buddy_earnings_ledger.platform_fee_basis_points` — the rate the
--     entries for that booking were computed under, recorded losslessly.
--
-- REVISED 2026-10-08 (lead ruling P-6), before this file was applied anywhere:
-- it no longer adds `commission_override_approval` or the CHECK
-- `rbfr_flat_rate_unless_approved`. Both were keyed by buddy level; the owner
-- keys a market override by product and market (OD-PAY-3), the charge's
-- commission policy carries exactly that keying, and the fee resolver refuses
-- any level row whose rate the charge does not take — so an approved off-flat
-- LEVEL row could never price anything, and the column was inert. See "WHERE A
-- MARKET OVERRIDE LIVES" below.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, constraint adds guarded on
-- pg_constraint, every UPDATE convergent. Creates no table, drops no column,
-- drops no constraint, adds/alters/drops no RLS policy, changes no grant, flips
-- no flag, and does NOT write to `schema_migration_ledger`.
--
-- NOT APPLIED ANYWHERE by the change that adds it. No database was written and
-- production was not read.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE OWNER DECISIONS THIS IMPLEMENTS (2026-10-04)
-- ══════════════════════════════════════════════════════════════════════════════
--   "Set the Rent-a-Buddy commission to a flat 10% across Buddy levels. Store
--    it in basis points (1000); allow market overrides only when separately
--    approved."
--
--   "Set the booking deposit to 0% for the first release. Remove the shipped
--    30% default."
--
-- The deposit half is entirely code (`services/rentBuddy/PricingService.ts`);
-- no column changes for it, and the reason is in that module's header.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY BASIS POINTS ARE REQUIRED AND NOT A PREFERENCE
-- ══════════════════════════════════════════════════════════════════════════════
-- `platform_fee_percent` is `integer`
-- (`artifacts/api-server/baseline/20260819_baseline_structure.sql:9064#platform_fee_percent`).
-- An integer percent cannot express 10.5 %, 9.75 % or any other fractional rate,
-- so the decision's "market overrides when separately approved" is not
-- representable in the column it would have to live in. That is an
-- expressibility defect, not a style question: the first approved override that
-- is not a whole percent would have to be rounded on its way into the schedule,
-- and the rounded number — not the approved one — is what every booking would
-- then be priced on and every buddy shown.
--
-- Basis points at `integer` give four decimal places of rate (0.01 % steps)
-- with no float anywhere, which matches how every amount in the ledger is
-- already carried (`09` §3 refusal 1: minor units, never floats).
--
-- ── Conversion is faithful, not a renumbering ───────────────────────────────
-- A 25 % row becomes 2500. The backfill multiplies by 100; it does not copy the
-- percent across. Rows seeded by the frozen legacy tree
-- (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#traveler_service_fee_pct)`,
-- 25 / 22 / 15 / 12 / 12) therefore land on 2500 / 2200 / 1500 / 1200 / 1200
-- before the flat rate is applied, so a database inspected mid-migration is
-- never carrying a rate 100× too small.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY `platform_fee_percent` IS KEPT, AND WHAT IT IS NOW FOR
-- ══════════════════════════════════════════════════════════════════════════════
-- It is `NOT NULL` with no default, so it cannot be dropped additively and an
-- INSERT cannot omit it. It stays, kept in step with the basis points, as a
-- LEGACY MIRROR for operator eyes and for the mobile list's ORDER BY — and
-- nothing prices from it any more. `lib/rentBuddyFeeSchedule.ts` selects only
-- the basis-point column, and
-- `src/test/rentBuddyCommissionBasisPoints.test.ts` asserts that no pricing
-- path reads the percent column. Where a rate is not a whole
-- percent the mirror is the ROUNDED value and is therefore WRONG by up to
-- 0.5 pp; that is tolerable only because it is read by nothing that computes
-- money, which is the property under test.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHERE A MARKET OVERRIDE LIVES (lead ruling P-6, 2026-10-08)
-- ══════════════════════════════════════════════════════════════════════════════
-- "Market overrides only when separately approved" is a sentence until
-- something refuses an unapproved one. That refusal is NOT on this table:
--
--   * the commission the checkout TAKES is resolved by (product, seller market)
--     in services/payments/bookingPayments/commissionPolicy.ts (lane B, #640) —
--     a reviewed code change with a version per rule, which is what "separately
--     approved" means for a market override;
--   * `resolveFeeSchedule` (lib/rentBuddyFeeSchedule.ts) refuses any level row
--     whose rate is not that policy's, so a hand-edited off-flat row is a
--     refusal, never a price the checkout does not charge;
--   * the admin fee-rules editor (`PATCH /rent-a-buddy/admin/fee-rules`) refuses
--     a non-flat rate before the statement is issued, with a stated reason.
--
-- A per-level approval column and CHECK were in the first draft of this file
-- and were removed before it was applied anywhere: under the product-and-market
-- keying no approved LEVEL row could ever price, so they were inert. The range
-- CHECK below stays.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT A ZERO-ROW TABLE MEANS HERE (it is not a failure)
-- ══════════════════════════════════════════════════════════════════════════════
-- `rent_buddy_fee_rules`' only seed lives in the frozen legacy tree, and
-- whether production holds those five rows is NOT KNOWN — production was not
-- read. This migration therefore seeds NOTHING. If the table is empty,
-- `resolveFeeSchedule` answers `no_such_level` for every buddy and every
-- fee-dependent route refuses; an absent schedule shows up as a refusal, which
-- is the correct fail-closed outcome and is what the postconditions below allow
-- for. Seeding a rate into a table whose contents are unknown would be
-- inventing a price, which is the defect this whole lane exists to remove.
--
-- `'standard'` is likewise NOT seeded by THIS file. It is settable by an admin
-- route and had never had a fee row, so every fee route refused for such a
-- buddy. This migration PRESERVES that refusal deliberately — see
-- `lib/rentBuddyFeeSchedule.ts`' header — because a level nobody priced must
-- not acquire a price as a side effect of a storage change.
--
-- ── SUPERSEDED, LATER THE SAME DAY, BY A PRICING DECISION ───────────────────
-- The owner subsequently priced it: "Seed the `standard` Buddy level at the
-- approved flat 10% commission so its fee routes work."
-- `3602_rent_buddy_standard_level_commission_seed.sql` carries that seed, in its
-- own file so that THIS file's record — that the storage change invented no
-- price — stays true and separable. The paragraph above is therefore still an
-- accurate statement about 3601 and no longer the final state of the schedule.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEPLOY ORDERING — READ THIS BEFORE SHIPPING THE CODE
-- ══════════════════════════════════════════════════════════════════════════════
-- `resolveFeeSchedule` selects `platform_fee_basis_points` explicitly. Against a
-- database where this file has not run, that select fails (42703) and the
-- resolver returns `read_failed`, so every fee-dependent route REFUSES. That is
-- deliberate — the alternative is reading a missing column as "no rate", i.e.
-- the absent-row-as-deliberate-value defect one layer down — but it means this
-- migration must be applied BEFORE or WITH the deploy that carries the code.
-- `rent_buddy_enabled` is FALSE on every database and `pay-deposit` /
-- `pay-full` return 503, so the blast radius of getting the order wrong today is
-- two estimate screens returning an error instead of an estimate.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
--   db/rollback/2026-10-08-3601-rent-buddy-commission-basis-points-rollback.sql
-- drops both basis-point columns and both range CHECKs, and REFUSES while any
-- schedule or ledger rate is not exactly its integer percent x 100: dropping the
-- columns would discard the only lossless record of the rate those rows were
-- computed under. Roll back 3603 and 3602 first.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. rent_buddy_fee_rules: the schedule of record ────────────────────────
ALTER TABLE public.rent_buddy_fee_rules
  ADD COLUMN IF NOT EXISTS platform_fee_basis_points integer;

-- Faithful conversion of whatever is there: 25 % -> 2500. Only rows that have
-- not been converted yet, so a re-run never multiplies twice.
UPDATE public.rent_buddy_fee_rules
   SET platform_fee_basis_points = platform_fee_percent * 100
 WHERE platform_fee_basis_points IS NULL;

-- The owner decision: one rate, every buddy level. A market override is not a
-- level row's business (see "WHERE A MARKET OVERRIDE LIVES"), so every row lands
-- on the flat rate and the postconditions say so out loud. A RE-RUN converges
-- every level to 1000 again: a later commission change is a new migration that
-- re-states the rate together with the charge's policy, and until then a level
-- row at any other rate is refused by the resolver, never priced.
UPDATE public.rent_buddy_fee_rules
   SET platform_fee_basis_points = 1000
 WHERE platform_fee_basis_points IS DISTINCT FROM 1000;

-- The legacy mirror follows the basis points, never the other way round.
-- ROUND(x/100.0) and not x/100: integer division would floor a future
-- 1050 to 10 silently, and a mirror that is wrong in a predictable direction
-- is worse than one that is merely imprecise.
UPDATE public.rent_buddy_fee_rules
   SET platform_fee_percent = ROUND(platform_fee_basis_points / 100.0)::int
 WHERE platform_fee_percent IS DISTINCT FROM ROUND(platform_fee_basis_points / 100.0)::int;

ALTER TABLE public.rent_buddy_fee_rules
  ALTER COLUMN platform_fee_basis_points SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_fee_rules'::regclass
       AND conname  = 'rbfr_basis_points_range'
  ) THEN
    ALTER TABLE public.rent_buddy_fee_rules
      ADD CONSTRAINT rbfr_basis_points_range
      CHECK (platform_fee_basis_points BETWEEN 0 AND 10000);
  END IF;
END $$;

COMMENT ON COLUMN public.rent_buddy_fee_rules.platform_fee_basis_points IS
  'Portava''s commission, in basis points. 10 % == 1000. The rate of record: '
  'lib/rentBuddyFeeSchedule.ts reads THIS column and no other, and refuses a '
  'row whose rate the checkout''s commission policy does not charge. Flat across '
  'buddy levels by owner decision 2026-10-04; a market override lives in that '
  'policy (by product and market), never on a level row (lead ruling P-6).';

COMMENT ON COLUMN public.rent_buddy_fee_rules.platform_fee_percent IS
  'SUPERSEDED by platform_fee_basis_points (3601). Kept because it is NOT NULL '
  'and cannot be dropped additively, and kept IN STEP with the basis points, '
  'but no pricing path reads it. Where a rate is not a whole percent this '
  'mirror is rounded and therefore wrong; do not compute money from it.';

-- ─── 2. rent_buddy_earnings_ledger: record the rate losslessly ──────────────
-- Nullable on purpose. Rows written before this migration were computed under
-- the integer percent and there is no lossless value to backfill for them; a
-- synthesised one would be a money record stating a rate nobody recorded.
-- NULL here means "this row predates the basis-point rate", which is a fact.
ALTER TABLE public.rent_buddy_earnings_ledger
  ADD COLUMN IF NOT EXISTS platform_fee_basis_points integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
       AND conname  = 'rbel_basis_points_range'
  ) THEN
    ALTER TABLE public.rent_buddy_earnings_ledger
      ADD CONSTRAINT rbel_basis_points_range
      CHECK (platform_fee_basis_points IS NULL
             OR platform_fee_basis_points BETWEEN 0 AND 10000);
  END IF;
END $$;

COMMENT ON COLUMN public.rent_buddy_earnings_ledger.platform_fee_basis_points IS
  'The commission rate this estimate row was computed under, in basis points. '
  'NULL only for rows written before 3601. platform_fee_percent beside it is '
  'the rounded legacy mirror.';

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — this migration fails loudly rather than silently no-opping
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_rows        bigint;
  v_levels      text;
  v_null_bps    bigint;
  v_not_flat    bigint;
  v_mirror_off  text;
  v_atttype     text;
  v_notnull     boolean;
BEGIN
  -- 1. The column exists, is integer, and is NOT NULL.
  SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull
    INTO v_atttype, v_notnull
    FROM pg_attribute a
   WHERE a.attrelid = 'public.rent_buddy_fee_rules'::regclass
     AND a.attname  = 'platform_fee_basis_points'
     AND a.attnum > 0 AND NOT a.attisdropped;

  IF v_atttype IS NULL THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: rent_buddy_fee_rules.platform_fee_basis_points does not exist.';
  END IF;
  IF v_atttype <> 'integer' THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: platform_fee_basis_points is %, expected integer (a basis point is a whole number by construction).',
      v_atttype;
  END IF;
  IF NOT v_notnull THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: platform_fee_basis_points is nullable; a schedule row with no rate must be impossible, not merely unusual.';
  END IF;

  -- 2. The range constraint is present BY NAME. A CHECK that was never added
  --    is the whole difference between a rule and a comment.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_fee_rules'::regclass
       AND conname = 'rbfr_basis_points_range' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION '3601 postcondition FAILED: rbfr_basis_points_range is missing.';
  END IF;

  -- 2b. No per-level approval layer (lead ruling P-6). A table carrying the first
  --     draft's approval column or CHECK has an override mechanism that can never
  --     price; refuse rather than leave it looking like one.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
       AND attname = 'commission_override_approval' AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_fee_rules'::regclass
       AND conname = 'rbfr_flat_rate_unless_approved'
  ) THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: rent_buddy_fee_rules carries a per-level approval column or CHECK. Market overrides live in the charge''s commission policy (by product and market); a level-row approval can never price (lead ruling P-6). Drop it deliberately before applying this file.';
  END IF;

  -- 3. The data. Zero rows is a legitimate state (see the header) — these
  --    assertions are about what the rows that DO exist say.
  SELECT count(*), string_agg(buddy_level, ', ' ORDER BY buddy_level)
    INTO v_rows, v_levels
    FROM public.rent_buddy_fee_rules;

  SELECT count(*) FILTER (WHERE platform_fee_basis_points IS NULL),
         count(*) FILTER (WHERE platform_fee_basis_points <> 1000)
    INTO v_null_bps, v_not_flat
    FROM public.rent_buddy_fee_rules;

  IF v_null_bps > 0 THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: % schedule row(s) still carry no basis-point rate.', v_null_bps;
  END IF;

  IF v_not_flat > 0 THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: % row(s) are not at 1000 basis points; the commission is flat across every level (owner decision 2026-10-04).', v_not_flat;
  END IF;

  -- 4. The legacy mirror agrees with the rate it mirrors.
  SELECT string_agg(
           format('%s(percent=%s, bps=%s)', buddy_level, platform_fee_percent, platform_fee_basis_points),
           ', ' ORDER BY buddy_level)
    INTO v_mirror_off
    FROM public.rent_buddy_fee_rules
   WHERE platform_fee_percent <> ROUND(platform_fee_basis_points / 100.0)::int;

  IF v_mirror_off IS NOT NULL THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: the legacy percent mirror disagrees with the basis points on: %', v_mirror_off;
  END IF;

  -- 5. The ledger column and its range check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.rent_buddy_earnings_ledger'::regclass
       AND attname = 'platform_fee_basis_points' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      '3601 postcondition FAILED: rent_buddy_earnings_ledger.platform_fee_basis_points does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
       AND conname = 'rbel_basis_points_range' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION '3601 postcondition FAILED: rbel_basis_points_range is missing.';
  END IF;

  IF v_rows = 0 THEN
    RAISE NOTICE
      '3601 OK (schema only): rent_buddy_fee_rules holds ZERO rows on this database, so no rate was converted and none was invented. Every fee-dependent route will REFUSE (no_such_level) until an operator seeds the schedule. Columns, NOT NULL and both range CHECKs are in place.';
  ELSE
    RAISE NOTICE
      '3601 OK: % schedule row(s) [%] all at 1000 basis points (10 %%), legacy percent mirror in step. ''standard'' is absent unless listed, and its refusal is preserved. Ledger rate column added (nullable for pre-3601 rows).',
      v_rows, v_levels;
  END IF;
END $$;

COMMIT;
