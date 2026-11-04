-- Rollback for 3921_graph_behavior_observations.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3921 DID: created the read-only view public.graph_behavior_observations.
-- WHAT THIS ROLLBACK DOES: drops the view (it holds no data) and deletes 3921's
-- schema_migration_ledger row so the applier re-applies it. With the view gone
-- the graph build's behaviour read fails soft (no behaviour edge written that
-- pass) and the reconcile leaves the family undecided — it never retires on a
-- failed read.

BEGIN;
DROP VIEW IF EXISTS public.graph_behavior_observations;
DELETE FROM public.schema_migration_ledger WHERE filename = '3921_graph_behavior_observations.sql';
COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.graph_behavior_observations') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3921 rollback): the view still exists.';
  END IF;
END $post$;
