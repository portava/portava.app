-- 3451_discovery_engagement_integrity_flag.sql
-- Discovery DV-12 (census-discovery §78): ONE capability flag, seeded OFF, for
-- the 03 §12 anti-gaming detector on Discovery's save evidence.
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
-- lib/discoveryRankDesigns.ts → lib/discoveryRankIntegrity.ts. ON adds six
-- batched reads per ranked request (discovery_places ×2, saved_places,
-- trust_reviews, profiles, user_follows) plus the Trust seam's trust_profiles.
--
-- Rollback: db/rollback/2026-09-28-3451-discovery-engagement-integrity-flag-rollback.sql
-- (deletes the row(s) while still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3451): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_engagement_integrity_enabled', false,
   'Discovery engagement integrity (census-discovery DV-12, §78): 03 §12''s detector over the candidate set''s saves (lib/discoveryRankIntegrity.ts) - open gaming_suspected reviews (farms, rings), automation bursts, pods, reciprocal saves, submitter self-network, new-account cohorts. ON: abusive saves are discounted out of the social-proof count, what remains is scaled by the clean share, an unauthored row stops paying the constant 0.6 unknown-author proxy, and an authored row carries its submitter''s trust score through the Trust seam. A discount on evidence, never a penalty on a person, never a public reason. Any failed read leaves the set unmeasured (today''s numbers). OFF / absent / unreadable (the seed): nothing is read; social proof is exactly as before. Enabling in production is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_engagement_integrity_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3451): expected discovery_engagement_integrity_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_engagement_integrity_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3451): discovery_engagement_integrity_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
END $post$;
