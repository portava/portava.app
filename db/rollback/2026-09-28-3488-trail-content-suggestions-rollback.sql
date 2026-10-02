-- Rollback for 3488_trail_content_suggestions.sql (census-discovery §86, lane W10-T).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- REFUSES while any suggestion is still PENDING: those are proposals their owners
-- have not answered, and dropping them silently answers "no". Decided rows are
-- history; dropping them is covered by the retention entry D-W10T-14. After the
-- rollback a stranger's suggestion answers 503 (it fails closed; it never falls
-- back to spending the owner's §4 budget). Deletes 3488's ledger row.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.trail_content_suggestions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.trail_content_suggestions WHERE state = 'pending') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3488): pending suggestions exist. Let their owners decide, or decline them deliberately, first.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.trail_content_suggestions;
DELETE FROM public.schema_migration_ledger WHERE filename = '3488_trail_content_suggestions.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.trail_content_suggestions') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3488 rollback): the table survived.';
  END IF;
END $post$;
