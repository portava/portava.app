-- 3932_retire_rent_buddy_kyc_override.sql
-- Lane B (payments / identity / Trust), wave 3, item N-1. Written, NOT applied
-- to any database by the lane that wrote it.
--
-- Deletes the `rent_buddy_allow_bookings_without_kyc` feature_flags row, the
-- shape 0209_retire_freeze_flags.sql and 2962_retire_unread_sensing_flags.sql
-- set for retiring a flag that nothing reads.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY IT IS RETIRED, NOT KEPT AT FALSE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2074 seeded it FALSE and 2085 re-seeded it FALSE (and asserted FALSE). It was
-- the escape hatch that let Rent-a-Buddy booking creation proceed while identity
-- verification was not operational. The owner ruled on 2026-10-04 that
-- first-release bookings require REAL identity verification: "No tester bypass
-- or sandbox verification key." Since lane B's wave 2, lib/rentBuddyKycGate.ts
-- reads no flag at all, so a TRUE row opens nothing (test/rentBuddyKycGate.test.ts,
-- test/rentABuddyGateConsolidation.test.ts N-1, test/rentABuddySpecBookingBypass.test.ts N-1).
--
-- A row that changes nothing is still a hazard. It reads to an operator like
-- a lever, so someone may flip it during an incident and take the silence that
-- follows as the feature being open or closed. Deleting it removes the lever.
-- routes/admin.ts HIDDEN_INERT_FLAGS is extended in the same commit, so the
-- admin list hides it, and PATCH /admin/feature-flags/:flag and its /metadata
-- sibling refuse it with 400 not_operational. That holds on a database where
-- this file has not been applied yet as well: the 0209/2962 pairing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY 2074 AND 2085 ARE NOT EDITED
-- ══════════════════════════════════════════════════════════════════════════════
-- Both are applied migrations, and their bytes are checksummed by the applier
-- (docs/migrations.md, "An applied migration file is a historical artifact").
-- check:flag-polarity scans migration TEXT for seeds, so it still sees them.
-- The flag's INERT_SEEDED_FLAGS declaration (scripts/check-flag-polarity.mjs,
-- disposition remove-from-seed) now names this file as the executed remedy.
--
-- NO DATA IS LOST AND NOTHING OBSERVABLE CHANGES. The row reads FALSE wherever
-- it exists (2085's postcondition refused any other value), and no code has
-- read it since wave 2. A database that never had the row is already in the end
-- state, so the DELETE is a no-op there. Nothing else is touched: no other flag,
-- no table, no function, no grant.
--
-- Rollback: none needed. If an owner ever wants a booking override again, it
-- must be a new, separately decided flag with a reader. Re-inserting this row
-- would bring back nothing but an inert switch.
BEGIN;

DO $$
DECLARE
  v_others_before int;
  v_others_after  int;
  v_deleted       int;
  v_left          int;
BEGIN
  SELECT count(*) INTO v_others_before
    FROM public.feature_flags
   WHERE flag <> 'rent_buddy_allow_bookings_without_kyc';

  DELETE FROM public.feature_flags
   WHERE flag = 'rent_buddy_allow_bookings_without_kyc';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Postcondition 1: the row is gone (0 or 1 deleted: `flag` is the key).
  SELECT count(*) INTO v_left
    FROM public.feature_flags
   WHERE flag = 'rent_buddy_allow_bookings_without_kyc';
  IF v_left <> 0 OR v_deleted > 1 THEN
    RAISE EXCEPTION '3932 POSTCONDITION FAILED: deleted %, % rent_buddy_allow_bookings_without_kyc row(s) remain', v_deleted, v_left;
  END IF;

  -- Postcondition 2: ONLY that row went. The Rent-a-Buddy master flag and its
  -- kill switches are other rows; retiring the override must never read as
  -- turning bookings on or off.
  SELECT count(*) INTO v_others_after
    FROM public.feature_flags
   WHERE flag <> 'rent_buddy_allow_bookings_without_kyc';
  IF v_others_after <> v_others_before THEN
    RAISE EXCEPTION '3932 POSTCONDITION FAILED: % other feature_flags row(s) before, % after', v_others_before, v_others_after;
  END IF;
END $$;

COMMIT;
