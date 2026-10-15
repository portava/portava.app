-- Rollback for 3806_memory_convergence_proposals.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3806 DID: created memory_convergence_proposals (RLS on, no policy,
-- service role only) and its guard trigger memory_convergence_proposals_guard().
-- WHAT THIS ROLLBACK DOES: refuses while any DISMISSED row exists — a dismissal
-- is the owner's decision that a photo does not belong to a Memory, and nothing
-- can re-derive it: dropping the table would make the detector propose those
-- photos again. Proposed rows are re-derived by the next detection and kept rows
-- by the photo already being in its Memory, so neither blocks. With no dismissal
-- left, it drops the table and the function. Run again after a rollback, this
-- file is a no-op.

BEGIN;

-- The table check and the row check are separate statements: PL/pgSQL plans a
-- statement when it first runs it, so the row check is never planned on a
-- database without the table.
DO $$
BEGIN
  IF to_regclass('public.memory_convergence_proposals') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_convergence_proposals WHERE state = 'dismissed') THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3806): memory_convergence_proposals holds dismissals — owners'' decisions nothing can re-derive. Dropping it would re-propose those photos.';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.memory_convergence_proposals;
DROP FUNCTION IF EXISTS public.memory_convergence_proposals_guard();
DELETE FROM public.schema_migration_ledger WHERE filename = '3806_memory_convergence_proposals.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_convergence_proposals') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806 rollback): memory_convergence_proposals still exists';
  END IF;
  IF to_regprocedure('public.memory_convergence_proposals_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3806 rollback): memory_convergence_proposals_guard() still exists';
  END IF;
END $post$;
