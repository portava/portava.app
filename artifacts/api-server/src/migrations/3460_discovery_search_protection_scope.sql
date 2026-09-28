-- 3460_discovery_search_protection_scope.sql
-- Discovery search — the protected-zone flag's DESCRIPTION follows its scope
-- (census-discovery §80, lane W10-S1, B04 / register D-W10-S1-3).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-S1
-- 3460-3464). APPLIED TO NO DATABASE by the lane that wrote it; rehearsed on
-- the local PostgreSQL 16 harness only.
--
-- Additive + idempotent. Safe to re-run. It changes ONE column of ONE row —
-- `feature_flags.description` for `discovery_search_protected_zones_enabled`
-- (seeded by 3366) — and NEVER `enabled`: the postcondition refuses a run that
-- finds the flag's state different from what it found before.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- 3366's description names two serve points, GET /discovery/search and
-- GET /discovery/suggest. §80 widened what the same flag governs, by the same
-- rule and the same reader (lib/discoverySearchProtection.ts):
--   * the input gateway's candidates (POST /input-assistance/suggest): a row
--     inside a suppress zone is no longer suggested by name, on any context
--     that dispatches the Discovery searchers (lib/inputAssistance/gateway.ts);
--   * the Map search sheet's page on that gateway (`global_search` /
--     `map.search`, lib/inputAssistance/searchPage.ts), whose projection
--     carries positions.
-- The description is what an operator reads when asked to flip the flag, so
-- it must say everything the flip does. Behaviour is unchanged by this file.
--
-- ── RUNTIME EFFECT: NONE ────────────────────────────────────────────────────
-- A description is read by no code path. The flag's value is untouched.
--
-- No dependency beyond 3366: where the row is absent (3366 unapplied) this is a
-- no-op and says so, because seeding the flag is 3366's job, not this file's.
--
-- Rollback: db/rollback/2026-09-28-3460-discovery-search-protection-scope-rollback.sql (census-discovery §90); it
-- restores 3366's wording and must run BEFORE 3366's rollback; nothing else changes here.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3460): public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TEMP TABLE _3460_before ON COMMIT DROP AS
  SELECT enabled FROM public.feature_flags WHERE flag = 'discovery_search_protected_zones_enabled';

UPDATE public.feature_flags
   SET description = 'Discovery search (census-discovery B04, §46, §80): Map spec §24 on every search serve that can disclose a position or a place by name — GET /discovery/search, GET /discovery/suggest, and the input gateway POST /input-assistance/suggest (its Discovery-searcher candidates on every context, and the Map search sheet''s map.search page). ON: each candidate is checked against protected_zones through lib/protectedLocations before projection — zones registered: allow / coarsen to the zone anchor / suppress the row (not served, not suggested by name); none registered: no change; policy unreadable: positions withheld, rows kept. OFF / absent / unreadable (the seed): the pass does not run and nothing is read.'
 WHERE flag = 'discovery_search_protected_zones_enabled';

DO $post$
DECLARE before_count int; after_state boolean; before_state boolean;
BEGIN
  SELECT count(*) INTO before_count FROM _3460_before;
  IF before_count = 0 THEN
    RAISE NOTICE '3460: discovery_search_protected_zones_enabled is absent (3366 unapplied) — nothing to describe';
    RETURN;
  END IF;
  SELECT enabled INTO before_state FROM _3460_before;
  SELECT enabled INTO after_state FROM public.feature_flags WHERE flag = 'discovery_search_protected_zones_enabled';
  IF after_state IS DISTINCT FROM before_state THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3460): the flag''s state changed (% -> %); this file may only change its description', before_state, after_state;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'discovery_search_protected_zones_enabled' AND description LIKE '%/input-assistance/suggest%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3460): the description does not name the gateway';
  END IF;
END $post$;

COMMIT;
