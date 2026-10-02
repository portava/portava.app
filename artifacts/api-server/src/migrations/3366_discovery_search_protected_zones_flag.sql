-- 3366_discovery_search_protected_zones_flag.sql
-- Discovery search — Map spec §24's protected-place gate on the search serve
-- points (census-discovery B04 / §46). ONE capability flag, seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery search
-- lane 3366-3369). APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `discovery_search_protected_zones_enabled`. ON: GET /discovery/search and
-- GET /discovery/suggest run every served position through
-- lib/protectedLocations.applyProtection, over the zones lib/protectedZoneStore
-- reads from `protected_zones` (migration 2217), as the last gate before the
-- response is serialized (lib/discoverySearchProtection.ts):
--   zones read, none registered  → identity; the body is byte-identical to OFF
--   zones read, some registered  → per row: allow / coarsen (position snapped
--                                  to the zone anchor) / suppress (not served)
--   zones UNREADABLE             → positions withheld, rows kept
-- OFF / absent / unreadable (the seed): the pass does not run and nothing is
-- read; every served body is exactly what it was before this file.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3366 and an applied one behave alike.
-- Reader: lib/discoverySearchProtection.searchProtectionEnabled.
-- Turning it ON is the owner's decision (census-discovery §46).
--
-- No dependency on 2217: the flag is readable without `protected_zones`, and
-- the reader treats an absent table as an unreadable policy (positions
-- withheld), never as "no zones".
--
-- Rollback: db/rollback/2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3366): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_search_protected_zones_enabled',
    false,
    'Discovery search (census-discovery B04, §46): Map spec §24 on GET /discovery/search and /discovery/suggest. ON: every served position is checked against protected_zones through lib/protectedLocations — zones registered: allow / coarsen to the zone anchor / suppress the row; none registered: no change; policy unreadable: positions withheld, rows kept. OFF / absent / unreadable (the seed): the pass does not run and search serves exactly what it served before.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_search_protected_zones_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3366): expected discovery_search_protected_zones_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_search_protected_zones_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3366): discovery_search_protected_zones_enabled is ON — enabling the search pass is an owner decision and this must ship OFF';
  END IF;
END $post$;
