-- Rollback for 3490_discovery_serve_path_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3490 DID
-- =============
--   * INSERT TWO ROWS into public.feature_flags, both FALSE, ON CONFLICT DO
--     NOTHING: 'discovery_community_byline_canonical_enabled' and
--     'discovery_platform_graph_provenance_enabled'. No table, no column, no
--     type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes both rows, and ONLY while each is still FALSE. If either reads TRUE
-- the owner has turned it on since 3490 was applied; deleting the row would
-- silently turn it off again (an absent row reads false) with no record that
-- the owner's decision was reversed. It raises instead and the operator
-- decides. Neither flag writes a row of its own, so there is nothing else to
-- remove. It then deletes 3490's schema_migration_ledger row, so a later run
-- of scripts/src/apply-migrations.ts re-applies 3490. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_community_byline_canonical_enabled', 'discovery_platform_graph_provenance_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3490): % of the two §94 flags is TRUE. The owner has turned it on since 3490 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.', on_count;
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag IN ('discovery_community_byline_canonical_enabled', 'discovery_platform_graph_provenance_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3490_discovery_serve_path_flags.sql';

COMMIT;

-- ── Postconditions: the rows are gone, and so is the ledger row ─────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_community_byline_canonical_enabled', 'discovery_platform_graph_provenance_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3490 rollback): a §94 flag is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3490_discovery_serve_path_flags.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3490 rollback): the ledger still records 3490 as applied.';
  END IF;
END $post$;
