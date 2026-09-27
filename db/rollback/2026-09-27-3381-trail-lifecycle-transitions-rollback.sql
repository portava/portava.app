-- Rollback for 3381_trail_lifecycle_transitions.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3381 DID
-- =============
--   * Created public.trails_lifecycle_transition() and its BEFORE UPDATE OF
--     lifecycle_status trigger trails_lifecycle_transition_trg on public.trails.
--   * Created public.content_trails_state_transition() and its BEFORE UPDATE OF
--     content_state trigger content_trails_state_transition_trg on
--     public.content_trails.
--   No row, column, CHECK, index, grant or policy was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops both triggers and both functions and deletes 3381's
-- schema_migration_ledger row. Free and lossless: nothing is deleted. What it
-- gives up is the database's refusal: `archived → active`, `proposed → stale`
-- and `just_arrived → rediscovered` are admitted again by any writer, and a
-- promotion racing an archive can revive the archived Trail (census-discovery
-- DC-04, §51; src/test/db/trailsConstraints.db.test.ts T1-T5, C1, C2 go red).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3381 rollback): public.trails / public.content_trails do not exist.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trails_lifecycle_transition_trg ON public.trails;
DROP TRIGGER IF EXISTS content_trails_state_transition_trg ON public.content_trails;
DROP FUNCTION IF EXISTS public.trails_lifecycle_transition();
DROP FUNCTION IF EXISTS public.content_trails_state_transition();

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3381_trail_lifecycle_transitions.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.trails_lifecycle_transition()') IS NOT NULL
     OR to_regprocedure('public.content_trails_state_transition()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381 rollback): a transition function still exists.';
  END IF;
  -- 2910's CHECKs must survive: the vocabulary is 2910's, the relation was 3381's.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trails'::regclass AND conname = 'trails_lifecycle_known')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.content_trails'::regclass AND conname = 'content_trails_state_known') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381 rollback): a 2910 vocabulary CHECK is gone; this rollback must not touch 2910.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3381_trail_lifecycle_transitions.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381 rollback): the ledger still records 3381 as applied.';
  END IF;
END $post$;
