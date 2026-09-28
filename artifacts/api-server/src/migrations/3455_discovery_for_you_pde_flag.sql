-- 3455_discovery_for_you_pde_flag.sql
-- census-discovery C32 / DC-24 / A05 (§79): ONE ranking pipeline for the signed-in `for_you` page.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery lane
-- W10-R4, range 3455-3459). APPLIED TO NO DATABASE by the lane that wrote it
-- other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via lib/featureFlags.isFlagEnabled (lib/discoveryOnePipeline).
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `discovery_for_you_pde_enabled`. It changes the ORDER a real user is served, so turning it on is
-- production activation — the owner's decision (Phase F gate 2; register
-- entry D-W10R4-2, APPROVAL REQUIRED). This file only creates it, OFF.
--   ON:  a signed-in GET /discovery?category=for_you page is ordered by the PDE
--        pipeline (lib/discoveryPde rankForViewer) and by nothing else, on the
--        cold path and on a Cache A hit. Compass's pipeline GATES (safety filter,
--        eligibility, safe-return attention, Live exclusions) decide which
--        candidates enter it (compass/CompassFeedBuilder
--        compassEligibleForDiscovery); Compass's score, Cache B and
--        rankItemsForDiscovery are not used. The intent mode (?intentMode=)
--        reaches the page through the live layer like every other category, and
--        the client's For You tab stops superseding the page with the Compass
--        feed (travel-buddy-standalone ForYouTab).
--   OFF / absent / unreadable (the seed): serve points 4 (compass_candidate_hit)
--        and 5 (compass_fresh_rank) are exactly what they were.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3455 and an applied one behave alike
-- (census-discovery §79: src/test/discoveryOnePipeline.test.ts Z0 replays the
-- legacy golden with this row FALSE; L0 replays it with the row absent).
-- Readers: routes/discovery.ts (forYouCandidatesForServe), and the client through
-- GET /api/feature-flags (components/discovery/ForYouTab.tsx).
--
-- Rollback: db/rollback/2026-09-28-3455-discovery-for-you-pde-enabled-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3455): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_for_you_pde_enabled',
    false,
    'census-discovery §79 (C32/DC-24): ON orders the signed-in for_you page with the PDE pipeline only; Compass''s pipeline gates decide which candidates enter it, and neither Compass''s score nor Cache B is used. The client For You tab then keeps the GET /discovery page instead of replacing it with the Compass feed. OFF / absent / unreadable (the seed): the Compass order on serve points 4 and 5, unchanged. Changes the order real users are served: turning it on is an owner decision (register D-W10R4-2).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_for_you_pde_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3455): expected discovery_for_you_pde_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_for_you_pde_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3455): discovery_for_you_pde_enabled is ON — it reorders every signed-in for_you page, enabling it is an owner decision, and this must ship OFF';
  END IF;
END $post$;
