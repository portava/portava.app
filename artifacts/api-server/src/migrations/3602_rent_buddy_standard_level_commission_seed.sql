-- 3602_rent_buddy_standard_level_commission_seed.sql
--
-- RENUMBERED 3521 -> 3602 on 2026-10-06 (lane P, PR #616), with its storage
-- change 3520 -> 3601; applied nowhere under either number. It still runs
-- directly after the file it depends on.
--
-- The `standard` Buddy level acquires the price the owner approved for it:
-- a flat 10 % commission, 1000 basis points.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
--
-- Additive and idempotent: ONE guarded INSERT, `ON CONFLICT DO NOTHING`, no
-- UPDATE anywhere. Creates no table, drops no column, adds/alters/drops no
-- constraint, adds/alters/drops no RLS policy, changes no grant, flips no flag,
-- and does NOT write to `schema_migration_ledger`.
--
-- NOT APPLIED ANYWHERE by the change that adds it. No database was written and
-- production was not read.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE OWNER DECISION THIS IMPLEMENTS (2026-10-04)
-- ══════════════════════════════════════════════════════════════════════════════
--   "Seed the `standard` Buddy level at the approved flat 10% commission so its
--    fee routes work."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A SEPARATE FILE FROM 3601, AND NOT A LINE ADDED TO IT
-- ══════════════════════════════════════════════════════════════════════════════
-- `3601_rent_buddy_commission_basis_points.sql` is the STORAGE change: it adds
-- `platform_fee_basis_points`, converts whatever rows exist faithfully, and
-- seeds NOTHING. Its header argues at length why it seeds nothing, and that
-- argument is correct and still load-bearing:
--
--   "a level nobody priced must not acquire a price as a side effect of a
--    storage change."
--
-- The owner has now priced it. That is a NEW FACT, dated after 3601 was
-- written, and it belongs in a file of its own for three reasons:
--
--   1. PROVENANCE. 3601's record of "the storage change invented no price"
--      stays true. If the seed were folded into 3601, the file would both make
--      that claim and contradict it, and a reader a year from now could not
--      tell which rows came from a storage decision and which from a pricing
--      decision. Here, the pricing decision carries its own quote and its own
--      date.
--   2. 3601's ZERO-ROW POSTCONDITION STAYS MEANINGFUL. 3601 ends by reporting
--      "rent_buddy_fee_rules holds ZERO rows on this database, so no rate was
--      converted and none was invented". Seeding inside it would make that
--      branch unreachable and delete the signal that the schedule was empty —
--      which is the one fact about production nobody has established.
--   3. SEPARATELY REVERTABLE. Un-pricing `standard` is deleting one row.
--      Reverting a storage change is dropping columns and losing the only
--      lossless record of the rate the ledger was computed under (3601's
--      own ROLLBACK note). Those are not the same risk and should not be
--      welded into one file.
--
-- It also means this file has a PRECONDITION rather than an assumption, which
-- is checked below and refuses loudly.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS SEEDS, AND WHAT IT DELIBERATELY DOES NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- ONE row: `buddy_level = 'standard'`, `platform_fee_basis_points = 1000`.
--
--   * 1000 is the approved flat rate, and it is the rate the checkout's
--     commission policy charges, which is what lets the fee resolver price the
--     row (it refuses any level row the charge does not share). There is no
--     approval column to write: lead ruling P-6 (2026-10-08) removed 3601's
--     per-level approval column and CHECK before either file was applied
--     anywhere, because a market override lives in that policy, not on a row.
--
--   * `platform_fee_percent` = 10. It is `NOT NULL` with no default, so an
--     INSERT cannot omit it. It is the LEGACY MIRROR (3601's comment on the
--     column); 10 is exactly `ROUND(1000 / 100.0)`, so 3601's mirror-agreement
--     postcondition holds for this row on a later re-run of 3601.
--
--   * `traveler_service_fee_usd` and `traveler_service_fee_pct` are NOT in the
--     column list either, so the row takes the column defaults, which are 0 and
--     0. This is deliberate and is NOT an oversight:
--
--       The owner priced the COMMISSION. The traveller-side service fee is a
--       different line, and whether it exists as a revenue line at all is
--       ruling R1, which is UNMADE (`08` §2.4, §7; `12` §4 Stage 2, and the
--       header of `lib/rentBuddyFeeSchedule.ts`). The five rows the frozen
--       legacy tree seeded carry `traveler_service_fee_pct = 5`
--       (`artifacts/api-server/migrations/0134_rent_buddy_schema_rebuild.sql:1208#traveler_service_fee_pct`).
--       Copying that 5 onto `standard` would be this file deciding a
--       traveller-side price, which is precisely the kind of invention 3601
--       refused to make. 0 is the column default and the only value here that
--       asserts nothing.
--
--     ⚠ CONSEQUENCE AN OPERATOR MUST KNOW: `standard` therefore carries a
--     traveller service fee of 0 while the legacy levels carry 5 %. Today that
--     difference is invisible — `travelerServiceFeeIsChargeable` gates on
--     `rent_buddy_enabled`, which is FALSE on every database, so the recorded
--     amount is 0 for every level regardless. It becomes visible the moment R1
--     is ruled and the master flag is flipped, and at that point the traveller
--     fee for `standard` is an owner decision that has not been made. It is
--     flagged in the PR rather than guessed at here.
--
-- Nothing else. The other buddy levels are not touched, not created, and not
-- re-rated: 3601 already converged every row that exists to 1000, and this file
-- asserts below that it changed none of them.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY `ON CONFLICT DO NOTHING` AND NEVER `DO UPDATE`
-- ══════════════════════════════════════════════════════════════════════════════
-- `rent_buddy_fee_rules_buddy_level_key` is `UNIQUE (buddy_level)`
-- (`artifacts/api-server/baseline/20260819_baseline_structure.sql:14288#rent_buddy_fee_rules_buddy_level_key`),
-- so the conflict target is the identity of a schedule row.
--
-- DO NOTHING is the difference between a seed and a reset. `rent_buddy_fee_rules`
-- is the schedule of record precisely because an operator can change it without
-- a deploy (`08` §2.3, and `lib/rentBuddyFeeSchedule.ts`' header). If this file
-- said `DO UPDATE SET platform_fee_basis_points = 1000`, then every re-run — a
-- reconcile, a restore rehearsal, a replay of the pending-apply list — would
-- silently revert an operator's later, deliberate edit to a rate this file
-- happens to name. A migration that overwrites live pricing on re-run is a
-- money defect with a schema defect's face.
--
-- DO NOTHING also makes duplication impossible: the unique key means the second
-- run has a conflict to do nothing about, so the row count after N runs is the
-- row count after one.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE ORDERING CONSEQUENCE IS UNCHANGED BY THIS FILE
-- ══════════════════════════════════════════════════════════════════════════════
-- `resolveFeeSchedule` selects `platform_fee_basis_points` explicitly. Against a
-- database where 3601 has not run, that select fails (42703) and the resolver
-- returns `read_failed`, so EVERY fee-dependent route refuses — for `standard`
-- exactly as for every other level. Seeding `standard` does not change that and
-- cannot: a row this file inserts is unreadable by a resolver that cannot name
-- the column. The migrations must be applied BEFORE or WITH the deploy that
-- carries the code, and 3601 must be applied before this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT MAKE TRUE
-- ══════════════════════════════════════════════════════════════════════════════
-- A readable rate is not a charge. `rent_buddy_enabled` is FALSE, `pay-deposit`
-- and `pay-full` return 503 `payment_stub:true`, the ledger row is an estimate,
-- and no payout exists (`09` §1.3). This file makes `standard`'s fee routes
-- answer with a price instead of a refusal. It moves no money and enables
-- nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
--   db/rollback/2026-10-08-3602-rent-buddy-standard-level-commission-seed-rollback.sql
-- deletes the `standard` row ONLY while it still carries exactly the seeded
-- values (an operator's later edit is refused, never destroyed); roll it back
-- before 3601's. Once a
-- `rent_buddy_earnings_entries` row exists for a `standard` buddy, that row
-- records the rate it was computed under
-- (`rent_buddy_earnings_ledger.platform_fee_basis_points`, 3601) and deleting
-- the schedule row does not and must not alter it. The consequence of the
-- DELETE is that `standard`'s fee routes go back to refusing, which is the
-- state this file changed and a legitimate state to return to.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Precondition: 3601 must have run ───────────────────────────────────────
-- Checked explicitly rather than left to the INSERT's own 42703, so the failure
-- names the file to apply instead of a missing column. A precondition that is
-- not met is a REFUSAL, never a skip: silently doing nothing here would leave
-- `standard` unpriced on a database an operator believes was seeded.
DO $$
BEGIN
  IF to_regclass('public.rent_buddy_fee_rules') IS NULL THEN
    RAISE EXCEPTION
      '3602 PRECONDITION FAILED: public.rent_buddy_fee_rules does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.rent_buddy_fee_rules'::regclass
       AND attname  = 'platform_fee_basis_points'
       AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      '3602 PRECONDITION FAILED: rent_buddy_fee_rules.platform_fee_basis_points does not exist. Apply 3601_rent_buddy_commission_basis_points.sql first — seeding a percent-only row would store the rate 100x too small.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_fee_rules'::regclass
       AND conname  = 'rbfr_basis_points_range' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      '3602 PRECONDITION FAILED: rbfr_basis_points_range is absent, so 3601 has not run to completion. Apply 3601 first.';
  END IF;
END $$;

-- ─── The seed, with its own before/after proof, in ONE block ────────────────
-- One row, one INSERT, no UPDATE. `traveler_service_fee_usd` and
-- `traveler_service_fee_pct` are absent from the column list on purpose — see
-- the header. 10 is the legacy mirror of 1000 basis points.
--
-- WHY THE SNAPSHOT IS A VARIABLE IN THIS BLOCK, NOT A TEMP TABLE (2026-10-09).
-- The first version snapshotted into a session temp table and read it from a
-- separate assertion-only DO block. certify:migrations stage 4 re-runs every
-- assertion-only DO block as its OWN request after the run committed, where
-- that temp table does not exist (check:migration-session-state; 3974 broke the
-- live apply this way). The "this file changed exactly one thing, and invented
-- nothing" comparison is only meaningful in the applying transaction, so it now
-- lives in the same block as the INSERT: the snapshot is a jsonb variable, taken
-- and compared in the block that writes. The block writes, so stage 4 never re-runs
-- it; what stage 4 does re-run (the block after it) recomputes everything from
-- the table and the catalog.
DO $$
DECLARE
  v_before     jsonb;
  v_bps        integer;
  v_percent    integer;
  v_changed    text;
  v_changed_std text;
  v_vanished   text;
  v_preexisted boolean;
BEGIN
  -- Snapshot: what the table says BEFORE the seed.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'buddy_level',               buddy_level,
           'platform_fee_basis_points', platform_fee_basis_points,
           'platform_fee_percent',      platform_fee_percent,
           'traveler_service_fee_usd',  traveler_service_fee_usd,
           'traveler_service_fee_pct',  traveler_service_fee_pct)), '[]'::jsonb)
    INTO v_before
    FROM public.rent_buddy_fee_rules;

  INSERT INTO public.rent_buddy_fee_rules (buddy_level, platform_fee_basis_points, platform_fee_percent)
  VALUES ('standard', 1000, 10)
  ON CONFLICT ON CONSTRAINT rent_buddy_fee_rules_buddy_level_key DO NOTHING;

  SELECT platform_fee_basis_points, platform_fee_percent
    INTO v_bps, v_percent
    FROM public.rent_buddy_fee_rules
   WHERE buddy_level = 'standard';

  -- THE RE-RUN / OPERATOR-EDIT GUARANTEE, asserted rather than asserted-in-prose.
  -- If a 'standard' row was already there, it must be EXACTLY as it was.
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_before) e WHERE e->>'buddy_level' = 'standard'
  ) INTO v_preexisted;

  -- Every row that existed before, compared with what is there now. Compared
  -- as text through the same jsonb rendering on both sides, so numeric scale
  -- and NULL compare exactly. 'standard' is reported apart: a pre-existing
  -- 'standard' row that moved is the overwrite this file must never do; any
  -- other level that moved is a level this file has no business touching.
  WITH b AS (
    SELECT e->>'buddy_level'               AS buddy_level,
           e->>'platform_fee_basis_points' AS bps,
           e->>'platform_fee_percent'      AS pct,
           e->>'traveler_service_fee_usd'  AS fee_usd,
           e->>'traveler_service_fee_pct'  AS fee_pct
      FROM jsonb_array_elements(v_before) e
  )
  SELECT string_agg(
           format('%s: bps %s -> %s, percent %s -> %s, fee_usd %s -> %s, fee_pct %s -> %s',
                  b.buddy_level,
                  b.bps, a.platform_fee_basis_points,
                  b.pct, a.platform_fee_percent,
                  b.fee_usd, a.traveler_service_fee_usd,
                  b.fee_pct, a.traveler_service_fee_pct),
           '; ' ORDER BY b.buddy_level) FILTER (WHERE b.buddy_level = 'standard'),
         string_agg(
           format('%s(bps %s -> %s, percent %s -> %s)',
                  b.buddy_level,
                  b.bps, a.platform_fee_basis_points,
                  b.pct, a.platform_fee_percent),
           ', ' ORDER BY b.buddy_level) FILTER (WHERE b.buddy_level <> 'standard')
    INTO v_changed_std, v_changed
    FROM b
    JOIN public.rent_buddy_fee_rules a ON a.buddy_level = b.buddy_level
   WHERE b.bps     IS DISTINCT FROM (to_jsonb(a.platform_fee_basis_points) #>> '{}')
      OR b.pct     IS DISTINCT FROM (to_jsonb(a.platform_fee_percent)      #>> '{}')
      OR b.fee_usd IS DISTINCT FROM (to_jsonb(a.traveler_service_fee_usd)  #>> '{}')
      OR b.fee_pct IS DISTINCT FROM (to_jsonb(a.traveler_service_fee_pct)  #>> '{}');

  IF v_changed_std IS NOT NULL THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: a pre-existing ''standard'' row was MODIFIED (%). This file must never overwrite a rate an operator set; ON CONFLICT DO NOTHING is the guarantee and it did not hold.',
      v_changed_std;
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: this file changed a level it has no business touching: %. It seeds ''standard'' and nothing else.',
      v_changed;
  END IF;

  SELECT string_agg(e->>'buddy_level', ', ' ORDER BY e->>'buddy_level')
    INTO v_vanished
    FROM jsonb_array_elements(v_before) e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.rent_buddy_fee_rules a WHERE a.buddy_level = e->>'buddy_level'
   );

  IF v_vanished IS NOT NULL THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: schedule row(s) for % are gone. This file deletes nothing.',
      v_vanished;
  END IF;

  IF v_preexisted THEN
    RAISE NOTICE
      '3602 OK (no-op): ''standard'' already carried % basis points and was left exactly as it was. A re-run neither duplicates nor overwrites.',
      v_bps;
  ELSE
    -- Freshly seeded: it must be the approved flat rate, with a mirror that
    -- agrees. Checked only on the row THIS run inserted — an operator's
    -- pre-existing row is their business and is covered above.
    IF v_bps IS DISTINCT FROM 1000 THEN
      RAISE EXCEPTION
        '3602 postcondition FAILED: ''standard'' was seeded at % basis points, not the approved flat 1000. The owner approved 10 %%; any other rate is a price nobody decided.',
        v_bps;
    END IF;

    IF v_percent IS DISTINCT FROM 10 THEN
      RAISE EXCEPTION
        '3602 postcondition FAILED: the legacy percent mirror is % and must be 10 to agree with 1000 basis points (3601 asserts this agreement for every row).',
        v_percent;
    END IF;

    RAISE NOTICE
      '3602 OK: ''standard'' seeded at 1000 basis points (10 %%), legacy percent mirror 10, traveller service fee at the column default of 0 (ruling R1 is unmade). Its fee routes now resolve instead of refusing.';
  END IF;
END $$;

COMMENT ON TABLE public.rent_buddy_fee_rules IS
  'The Rent-a-Buddy fee schedule of record, one row per buddy_level. The rate '
  'lives in platform_fee_basis_points (3601); platform_fee_percent is a rounded '
  'legacy mirror that nothing prices from. ''standard'' was seeded at the '
  'approved flat 1000 basis points by 3602 (owner decision 2026-10-04); a level '
  'with no row here is UNPRICED and every fee route refuses for it, which is a '
  'configuration state and not a default.';

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — re-runnable on their own (certify stage 4): every value is
-- recomputed from the table and the catalog; no temp table, no session state.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_bps     integer;
  v_rows    bigint;
BEGIN
  -- 1. The row exists, exactly once, and carries a basis-point rate.
  SELECT count(*), max(platform_fee_basis_points)
    INTO v_rows, v_bps
    FROM public.rent_buddy_fee_rules WHERE buddy_level = 'standard';

  IF v_rows = 0 OR v_bps IS NULL THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: there is no ''standard'' row carrying a basis-point rate. The seed did not take, so standard''s fee routes still refuse.';
  END IF;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: % rows for buddy_level ''standard''; the schedule''s unique key is the identity of a level and exactly one row may carry it.',
      v_rows;
  END IF;

  -- 2. 3601's range CHECK is still there and was not weakened on the way past.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_fee_rules'::regclass
       AND conname = 'rbfr_basis_points_range' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      '3602 postcondition FAILED: rbfr_basis_points_range is no longer present.';
  END IF;
END $$;

COMMIT;
