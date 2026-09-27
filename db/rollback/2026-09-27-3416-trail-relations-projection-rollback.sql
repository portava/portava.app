-- Rollback for 3416_trail_relations_projection.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3416 DID
-- =============
--   * Created public.trail_relations (RLS on, four restrictive client-deny
--     policies, service_role SELECT/INSERT/DELETE) and idx_trail_relations_to.
--   * Created public.rebuild_trail_relations(timestamptz).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the function and the table (its policies and index go with it) and
-- deletes 3416's schema_migration_ledger row. Free: the table is a DERIVED
-- projection of trail_edges, trails.parent_trail_id and content_trails, which
-- this rollback does not touch, so re-applying 3416 and calling the rebuild
-- restores every row. Nothing reads the table (census-discovery §61), so no
-- caller breaks. What it gives up: census-discovery DV-72's one rebuildable
-- Trail projection; src/test/db/trailRelationsRebuild.db.test.ts goes red.

BEGIN;

DROP FUNCTION IF EXISTS public.rebuild_trail_relations(timestamptz);
DROP TABLE IF EXISTS public.trail_relations;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3416_trail_relations_projection.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.trail_relations') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416 rollback): public.trail_relations still exists.';
  END IF;
  IF to_regprocedure('public.rebuild_trail_relations(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416 rollback): rebuild_trail_relations still exists.';
  END IF;
  -- The sources must survive: this rollback removes a projection, not what it projects.
  IF to_regclass('public.trail_edges') IS NULL OR to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416 rollback): a 2910 source table is gone; this rollback must not touch 2910.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3416_trail_relations_projection.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416 rollback): the ledger still records 3416 as applied.';
  END IF;
END $post$;
