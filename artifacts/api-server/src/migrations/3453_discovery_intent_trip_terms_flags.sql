-- 3453_discovery_intent_trip_terms_flags.sql
-- Discovery A18 and DV-18 (census-discovery §78): TWO capability flags, seeded
-- OFF - the explicit-intent term and the trip-fit term. Two flags in one file
-- because both are travel_intent-family terms from the same lane and range;
-- each has its own switch so either can be rolled back alone.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; census-discovery
-- §78, lane W10-R2 scoring designs, range 3450-3454). APPLIED TO NO DATABASE by
-- the lane that wrote it other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed through the shared getFlagRow (lib/discoveryRankFlags.ts),
-- so an absent row, a resolved error and a thrown client all read OFF.
--
-- The 2026-08-15 ranker hold was lifted by the owner on 2026-09-28 for BUILDING
-- behind flags seeded FALSE (docs/architecture/discovery-decision-register.md).
-- Turning any §78 flag on in production is PRODUCTION ACTIVATION and is NOT
-- delegated: it is register entry D-W10-R2-A1 (APPROVAL REQUIRED).
--
-- ── RUNTIME EFFECT OF SEEDING: NONE ────────────────────────────────────────
-- FALSE and absent read the same. Reader: lib/discoveryRankFlags.ts →
-- lib/discoveryRankDesigns.ts → lib/discoveryRankIntent.ts /
-- lib/discoveryRankTrip.ts. The request's intentMode reaches the ranker only
-- through census-discovery §78.9 hunk H2 (routes/discovery.ts); without it the
-- window source still answers.
--
-- Rollback: db/rollback/2026-09-28-3453-discovery-intent-trip-terms-flags-rollback.sql
-- (deletes the row(s) while still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3453): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_intent_term_enabled', false,
   'Discovery explicit-intent term (census-discovery A18, §78): Passport :94 - explicit current intent weighs more than generic interests. ON: the request''s declared intent mode (?intentMode=, the eight Sensing §8 modes), or else the viewer''s own ACTIVE EXPLICIT §8 availability window, is scored as intentMatch (weight 0.75, above interestTag 0.3 + categoryAffinity 0.4) using each mode''s own INTENT_MODE_PROFILES weights. Never a public reason. OFF / absent / unreadable (the seed): no intent read, no intentMatch key. Enabling in production is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_trip_match_enabled', false,
   'Discovery trip fit (census-discovery DV-18, §78): the trip_match producer. ON: the viewer''s own accepted current or upcoming trips (within 90 days), read through the Map''s trip reader (lib/mapProjectionTripRead.readTripStopLayer), give each candidate a fit from trip timing and city-scale proximity to the destination, scored as tripMatch (weight 0.3) and explained as trip_match with fixed text naming no destination or date. OFF / absent / unreadable (the seed): no trip read, no tripMatch key, and trip_match is never emitted. Enabling in production is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_intent_term_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3453): expected discovery_intent_term_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_intent_term_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3453): discovery_intent_term_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_trip_match_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3453): expected discovery_trip_match_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_trip_match_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3453): discovery_trip_match_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
END $post$;
