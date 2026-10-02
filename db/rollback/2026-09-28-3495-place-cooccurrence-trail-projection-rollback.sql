-- Rollback for 3495_place_cooccurrence_trail_projection.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3495 DID
-- =============
--   * Created public.place_cooccurrence (RLS on, four restrictive client-deny
--     policies, service_role SELECT/INSERT/DELETE) and idx_place_cooccurrence_b.
--   * Created public.rebuild_place_cooccurrence(timestamptz).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the function and the table (its policies and index go with it) and
-- deletes 3495's schema_migration_ledger row. Free: the table is a DERIVED
-- projection of content_trails and trails, which this rollback does not touch,
-- so re-applying 3495 and calling the rebuild restores every row. Its one
-- reader (lib/discoveryPlaceCooccurrence.ts) answers `unreadable` on a missing
-- table and its tick logs a failed run, so no caller breaks. What it gives up:
-- census-discovery DV-72's Trail-derived place co-occurrence;
-- src/test/db/placeCooccurrenceRebuild.db.test.ts goes red.

BEGIN;

DROP FUNCTION IF EXISTS public.rebuild_place_cooccurrence(timestamptz);
DROP TABLE IF EXISTS public.place_cooccurrence;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3495_place_cooccurrence_trail_projection.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.place_cooccurrence') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495 rollback): public.place_cooccurrence still exists.';
  END IF;
  IF to_regprocedure('public.rebuild_place_cooccurrence(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495 rollback): rebuild_place_cooccurrence still exists.';
  END IF;
  IF to_regclass('public.content_trails') IS NULL OR to_regclass('public.trails') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495 rollback): a 2910 source table is gone; this rollback must not touch 2910.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3495_place_cooccurrence_trail_projection.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495 rollback): the ledger still records 3495 as applied.';
  END IF;
END $post$;
