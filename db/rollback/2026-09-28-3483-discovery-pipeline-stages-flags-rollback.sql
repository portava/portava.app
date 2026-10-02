-- Rollback for 3483_discovery_pipeline_stages_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3483 DID
-- =============
--   * INSERTED 3 ROW(S) into public.feature_flags, each FALSE:
--       'discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled'
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes those rows, and ONLY while every one is still FALSE. If one reads TRUE
-- the owner has turned that §85 stage on since 3483 was applied; deleting the
-- row would silently turn it off (an absent row reads false) with no record that
-- the owner's decision was reversed. It raises instead and the operator decides.
-- It writes and deletes no other row: with the flags off no §85 stage wrote
-- anything, and a rank_events row a stage stamped while ON is a measurement,
-- whose removal is a retention decision, not a rollback of this file.
--
-- It then deletes 3483's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3483.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3483): a flag it seeded is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag IN ('discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3483_discovery_pipeline_stages_flags.sql';

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3483 rollback): a flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3483_discovery_pipeline_stages_flags.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3483 rollback): the ledger still records 3483 as applied.';
  END IF;
END $post$;
