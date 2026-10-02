-- 3456_discovery_cache_a_ranked_flag.sql
-- census-discovery DV-03 (§79): Cache A never bypasses personalization and ranking for a signed-in viewer.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery lane
-- W10-R4, range 3455-3459). APPLIED TO NO DATABASE by the lane that wrote it
-- other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via lib/featureFlags.isFlagEnabled (lib/discoveryOnePipeline).
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `discovery_cache_a_ranked_enabled`. It changes the ORDER a real user is served, so turning it on is
-- production activation — the owner's decision (Phase F gate 2; register
-- entry D-W10R4-2, APPROVAL REQUIRED). This file only creates it, OFF.
--   ON:  a signed-in Cache A hit (serve points 1/2/3) is ranked for the viewer
--        on the request (lib/discoveryPde rankForViewer, served: true, real
--        impression rows), in EVERY engine mode — exactly as the signed-in cold
--        fetch (serve point 6) already is in every mode. Cache A remains a
--        user-independent CANDIDATE cache; it is never a signed-in viewer's
--        final order. An anonymous request has no viewer and is unchanged.
--   OFF / absent / unreadable (the seed): the cached order is ranked only in
--        `pde` mode for an in-cohort viewer (DISCOVERY_ENGINE_MODE, 2091), as
--        before.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3456 and an applied one behave alike
-- (census-discovery §79: src/test/discoveryOnePipeline.test.ts Z0 replays the
-- legacy golden with this row FALSE; L0 replays it with the row absent).
-- Readers: routes/discovery.ts serveCachedPlaces (cacheARankedEnabled).
--
-- Rollback: db/rollback/2026-09-28-3456-discovery-cache-a-ranked-enabled-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3456): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_cache_a_ranked_enabled',
    false,
    'census-discovery §79 (DV-03): ON ranks every signed-in Cache A hit for its viewer on the request, in every engine mode, as the signed-in cold fetch already is; Cache A stays a user-independent candidate cache and is never a signed-in viewer''s final order. Anonymous requests are unchanged. OFF / absent / unreadable (the seed): ranked only in pde mode for an in-cohort viewer, as before. Changes the order real users are served: turning it on is an owner decision (register D-W10R4-2).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_cache_a_ranked_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3456): expected discovery_cache_a_ranked_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_cache_a_ranked_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3456): discovery_cache_a_ranked_enabled is ON — it reorders every signed-in cache-A serve, enabling it is an owner decision, and this must ship OFF';
  END IF;
END $post$;
