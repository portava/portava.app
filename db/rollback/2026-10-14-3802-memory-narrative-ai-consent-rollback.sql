-- Rollback for 3802_memory_narrative_ai_consent.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3802 DID: created memory_narrative_ai_consent and seeded
-- memory_narrative_ai_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: removes both — ONLY while the flag is FALSE and no
-- one has opted in (a consent row is a person's recorded choice; it is not
-- silently discarded). No Memory and no generated text is touched either way:
-- 3802 never stored any. Deletes 3802's ledger row so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3802): memory_narrative_ai_enabled is TRUE. Turn it off deliberately first.';
  END IF;
  -- NESTED, not `to_regclass(...) IS NOT NULL AND EXISTS (SELECT ... FROM the table)`:
  -- SQL does not promise to short-circuit AND, and PL/pgSQL plans the whole
  -- expression, so on a re-run (table already dropped) the one-line form fails
  -- with 42P01 instead of being the no-op a rollback must be. A nested IF's body
  -- is planned only when it runs. (Measured on PGlite, 2026-10-14.)
  IF to_regclass('public.memory_narrative_ai_consent') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_narrative_ai_consent) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3802): memory_narrative_ai_consent holds recorded choices. Decide what happens to them first.';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.memory_narrative_ai_consent;
DELETE FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3802_memory_narrative_ai_consent.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_narrative_ai_consent') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802 rollback): memory_narrative_ai_consent is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_narrative_ai_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3802 rollback): the flag is still present.';
  END IF;
END $post$;
