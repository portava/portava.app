-- Rollback for 3470_discovery_stop_enforcement_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3470 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('discovery_stop_enforcement_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has armed the stop conditions since 3470 was applied (register
-- D-W10-O-3); deleting the row would silently disarm them (an absent row reads
-- false) with no record that the owner's decision was reversed. It raises
-- instead and the operator decides. To disarm on purpose, UPDATE the row to
-- FALSE; the next non-legacy resolution reads it and the decided table stops
-- applying.
--
-- It then deletes 3470's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3470. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_stop_enforcement_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3470): discovery_stop_enforcement_enabled is TRUE. The owner armed the stop conditions since 3470 was applied; deleting the row would silently disarm them. Set it FALSE deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'discovery_stop_enforcement_enabled' AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3470_discovery_stop_enforcement_flag.sql';

COMMIT;

-- ── Postconditions: the row is gone, and so is the ledger row ───────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_stop_enforcement_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3470 rollback): discovery_stop_enforcement_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3470_discovery_stop_enforcement_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3470 rollback): the ledger still records 3470 as applied.';
  END IF;
END $post$;
