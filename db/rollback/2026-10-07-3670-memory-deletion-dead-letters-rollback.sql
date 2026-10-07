-- Rollback for 3670_memory_deletion_dead_letters.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3670 DID: created public.memory_deletion_dead_letters (and its two
-- indexes) — the durable record of a Memory deletion whose §21 lifecycle
-- exhausted a step's retries.
-- WHAT THIS ROLLBACK DOES: drops it — ONLY while it holds no OPEN letter. An
-- open letter is a deletion that did not finish (a derivative, an evidence row
-- or a cached projection may still exist for a Memory the person deleted);
-- dropping it silently would lose the only record that the cleanup is owed, so
-- the rollback RAISES instead. Resolved letters may go. With the table gone the
-- writer reports `deadLetterDurable: false` again, exactly as before 3670.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_deletion_dead_letters') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.memory_deletion_dead_letters WHERE resolved_at IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3670): memory_deletion_dead_letters holds open dead letters. Finish or record those deletions first.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.memory_deletion_dead_letters;
DELETE FROM public.schema_migration_ledger WHERE filename = '3670_memory_deletion_dead_letters.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_deletion_dead_letters') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670 rollback): memory_deletion_dead_letters still exists';
  END IF;
END $post$;
