-- Rollback for 3480_discovery_candidate_sources_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3480 DID
-- =============
--   * INSERTED 2 ROW(S) into public.feature_flags, each FALSE:
--       'discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled'
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes those rows, and ONLY while every one is still FALSE. If one reads TRUE
-- the owner has turned that §85 stage on since 3480 was applied; deleting the
-- row would silently turn it off (an absent row reads false) with no record that
-- the owner's decision was reversed. It raises instead and the operator decides.
-- It writes and deletes no other row: with the flags off no §85 stage wrote
-- anything, and a rank_events row a stage stamped while ON is a measurement,
-- whose removal is a retention decision, not a rollback of this file.
--
-- It then deletes 3480's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3480.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3480): a flag it seeded is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag IN ('discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3480_discovery_candidate_sources_flag.sql';

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3480 rollback): a flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3480_discovery_candidate_sources_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3480 rollback): the ledger still records 3480 as applied.';
  END IF;
END $post$;
