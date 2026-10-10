-- Rollback for 3703_sensing_consent_grants.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Drops sensing_consent_grants and the sensing_consent_split_enabled flag row.
-- REFUSES while the flag is TRUE: with the split live, dropping the table would
-- silently withdraw every recorded sensing consent and stop every device's
-- capture without telling anyone why. Turn the flag off first, on purpose.
-- ⚠ The grants are the record of what each person agreed to; this deletes it.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'sensing_consent_split_enabled' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3703): sensing_consent_split_enabled is TRUE. Turn it off first.';
  END IF;
END $pre$;

DROP TABLE IF EXISTS public.sensing_consent_grants;
DELETE FROM public.feature_flags WHERE flag = 'sensing_consent_split_enabled';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.sensing_consent_grants') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3703): sensing_consent_grants still exists.';
  END IF;
END $post$;
