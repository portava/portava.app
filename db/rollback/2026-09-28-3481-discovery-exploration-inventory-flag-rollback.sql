-- Rollback for 3481_discovery_exploration_inventory_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3481 DID
-- =============
--   * INSERTED 1 ROW(S) into public.feature_flags, each FALSE:
--       'discovery_exploration_inventory_enabled'
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes those rows, and ONLY while every one is still FALSE. If one reads TRUE
-- the owner has turned that §85 stage on since 3481 was applied; deleting the
-- row would silently turn it off (an absent row reads false) with no record that
-- the owner's decision was reversed. It raises instead and the operator decides.
-- It writes and deletes no other row: with the flags off no §85 stage wrote
-- anything, and a rank_events row a stage stamped while ON is a measurement,
-- whose removal is a retention decision, not a rollback of this file.
--
-- It then deletes 3481's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3481.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_exploration_inventory_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3481): a flag it seeded is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag IN ('discovery_exploration_inventory_enabled') AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3481_discovery_exploration_inventory_flag.sql';

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_exploration_inventory_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3481 rollback): a flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3481_discovery_exploration_inventory_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3481 rollback): the ledger still records 3481 as applied.';
  END IF;
END $post$;
