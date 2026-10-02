-- Rollback for 3460_discovery_search_protection_scope.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3460 DID
-- =============
--   * UPDATEd the description of ONE row, public.feature_flags
--     'discovery_search_protected_zones_enabled' (seeded by 3366), to name the
--     input gateway and the Map search sheet. The flag's value is untouched.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHY THIS FILE EXISTS (census-discovery §90)
-- ===========================================
-- 3460 shipped without a rollback ("re-run 3366's description in an UPDATE").
-- Once §87 (W10-F) made 3366's rollback delete the flag only while it still
-- carries 3366's own seed text, rolling 3366 back with 3460 applied correctly
-- KEEPS the row (it no longer looks like 3366's). The recovery order is
-- therefore 3460's rollback first, then 3366's; this is 3460's.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores 3366's seed description, and ONLY where the description is still
-- 3460's text byte for byte: an operator's later edit is kept. The flag's value
-- is never touched. Then deletes 3460's schema_migration_ledger row, so the
-- applier re-applies 3460.

BEGIN;

UPDATE public.feature_flags
   SET description = 'Discovery search (census-discovery B04, §46): Map spec §24 on GET /discovery/search and /discovery/suggest. ON: every served position is checked against protected_zones through lib/protectedLocations — zones registered: allow / coarsen to the zone anchor / suppress the row; none registered: no change; policy unreadable: positions withheld, rows kept. OFF / absent / unreadable (the seed): the pass does not run and search serves exactly what it served before.'
 WHERE flag = 'discovery_search_protected_zones_enabled'
   AND description = 'Discovery search (census-discovery B04, §46, §80): Map spec §24 on every search serve that can disclose a position or a place by name — GET /discovery/search, GET /discovery/suggest, and the input gateway POST /input-assistance/suggest (its Discovery-searcher candidates on every context, and the Map search sheet''s map.search page). ON: each candidate is checked against protected_zones through lib/protectedLocations before projection — zones registered: allow / coarsen to the zone anchor / suppress the row (not served, not suggested by name); none registered: no change; policy unreadable: positions withheld, rows kept. OFF / absent / unreadable (the seed): the pass does not run and nothing is read.';

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3460_discovery_search_protection_scope.sql';

COMMIT;

-- ── Postconditions: 3460's wording is gone, and so is its ledger row ─────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_search_protected_zones_enabled'
                AND description = 'Discovery search (census-discovery B04, §46, §80): Map spec §24 on every search serve that can disclose a position or a place by name — GET /discovery/search, GET /discovery/suggest, and the input gateway POST /input-assistance/suggest (its Discovery-searcher candidates on every context, and the Map search sheet''s map.search page). ON: each candidate is checked against protected_zones through lib/protectedLocations before projection — zones registered: allow / coarsen to the zone anchor / suppress the row (not served, not suggested by name); none registered: no change; policy unreadable: positions withheld, rows kept. OFF / absent / unreadable (the seed): the pass does not run and nothing is read.') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3460 rollback): the flag still carries 3460''s description.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3460_discovery_search_protection_scope.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3460 rollback): the ledger still records 3460 as applied.';
  END IF;
END $post$;
