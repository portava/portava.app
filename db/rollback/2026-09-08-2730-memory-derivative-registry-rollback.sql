-- Rollback for 2730_memory_derivative_registry.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908151001. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- Rehearsed on CI inside a transaction that was ROLLED BACK, counting residue by
-- NAME rather than by argument: relations 5 → 0, constraints 3 → 0, triggers
-- 1 → 0, grants → 0. `public.set_updated_at()` SURVIVES, which is correct and is
-- the one thing a careless inverse would get wrong: that function is shared with
-- most of the schema and predates this table by two thousand migrations.
-- `public.memories` still has its 21 columns — 2730 adds none, and neither may
-- its inverse.
--
-- SAFE WHILE NOTHING IS WRITTEN, and that is measured rather than assumed: the
-- table held 0 rows at rehearsal time and no code writes it. The table's own
-- COMMENT states the property that makes the DROP recoverable at all — "every
-- row is rebuildable from public.memories; deleting a row destroys no truth".
-- That is a claim about a builder that does not exist yet. Once one does, this
-- DROP discards built artifacts that a rebuild must reproduce; it still destroys
-- no TRUTH, but it does destroy work.

BEGIN;

DROP TABLE IF EXISTS public.memory_derivative_registry;

DO $$
DECLARE
  leftover_relations  INTEGER;
  leftover_constraints INTEGER;
  leftover_triggers   INTEGER;
  memories_cols       INTEGER;
BEGIN
  SELECT count(*) INTO leftover_relations
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'memory\_derivative\_registry%';
  IF leftover_relations <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2730 survive', leftover_relations;
  END IF;

  SELECT count(*) INTO leftover_constraints FROM pg_constraint
   WHERE conname LIKE 'memory\_derivative\_registry%';
  IF leftover_constraints <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % constraint(s) survive', leftover_constraints;
  END IF;

  SELECT count(*) INTO leftover_triggers FROM pg_trigger
   WHERE tgname LIKE 'memory\_derivative\_registry%';
  IF leftover_triggers <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % trigger(s) survive', leftover_triggers;
  END IF;

  -- The shared function must NOT go with the table.
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.set_updated_at() was dropped -- it is shared with most of the schema and 2730 did not create it';
  END IF;

  SELECT count(*) INTO memories_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memories';
  IF memories_cols <> 21 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.memories has % columns, expected the 21 it had before and after 2730', memories_cols;
  END IF;
END $$;

COMMIT;
