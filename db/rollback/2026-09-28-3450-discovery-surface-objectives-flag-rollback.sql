-- Rollback for 3450_discovery_surface_objectives_flag.sql (census-discovery §78, lane W10-R2)
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3450 DID
-- =============
--   * INSERT into public.feature_flags, ON CONFLICT DO NOTHING:
--       ('discovery_surface_objectives_enabled', false, '<description>', <metadata>)
--     No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes the row(s), and ONLY while every one is still FALSE. A TRUE row means
-- the owner has activated the design since 3450 was applied (register entry
-- D-W10-R2-A1); deleting it would silently turn it off (an absent row reads
-- false) with no record that the owner's decision was reversed. It raises
-- instead and the operator decides.
--
-- Nothing else to undo: the flag(s) gate reads and ranking arithmetic only; no
-- row anywhere was written because of them.
--
-- It then deletes 3450's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3450. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_surface_objectives_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3450): a flag this file removes is TRUE. The owner has activated it since 3450 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag IN ('discovery_surface_objectives_enabled') AND enabled = FALSE;

-- Guarded: the ledger exists on every applied database, but not on the local
-- harness (scripts/local-db), where this file is rehearsed.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3450_discovery_surface_objectives_flag.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions: the row(s) are gone, and so is the ledger row ───────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('discovery_surface_objectives_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3450 rollback): a flag is still present.';
  END IF;
  -- Nested, not ANDed: PL/pgSQL plans the whole condition, and the relation may not exist.
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3450_discovery_surface_objectives_flag.sql') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3450 rollback): the ledger still records 3450 as applied.';
    END IF;
  END IF;
END $post$;
