-- Rollback for 3360_intel_evidence_sealed_reference.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3360 DID
-- =============
--   * ADD CONSTRAINT intel_evidence_media_reference_sealed ... NOT VALID
--     (photo/video reference NULL or `ievr1.<base64url>`), with a comment;
--   * CREATE FUNCTION public.intel_evidence_rekey_reference(uuid, text, text),
--     SECURITY DEFINER, EXECUTE to service_role only;
--   * replaced COMMENT ON COLUMN public.intel_evidence.reference.
--   No row was written. No flag was added.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the function and the constraint and restores 2223's column comment
-- verbatim. It REFUSES while 3361 is applied (the constraint VALIDATED and the
-- function gone): roll 3361 back first, so the two files unwind in order.
-- It also deletes 3360's schema_migration_ledger row, which
-- scripts/src/apply-migrations.ts writes in the same transaction as the file:
-- a rolled-back file the ledger still calls applied is never re-applied by the
-- runner (rehearsed on the local harness, census-map §45.11).
--
-- WHAT IT DOES NOT DO: un-seal anything. Rows re-sealed through the function
-- stay sealed. Turning them back into plaintext keys would re-introduce the
-- account id this migration exists to keep out of the table, and there is no
-- database-side way to do it anyway: the key that opens them is not in the
-- database. Rolling back 3360 therefore does not require, and must not be
-- followed by, rolling back the application's seal.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
       AND convalidated
  ) AND to_regprocedure('public.intel_evidence_rekey_reference(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: 3361 is applied (constraint validated, function dropped). Roll 3361 back first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.intel_evidence_rekey_reference(uuid, text, text);

ALTER TABLE public.intel_evidence
  DROP CONSTRAINT IF EXISTS intel_evidence_media_reference_sealed;

COMMENT ON COLUMN public.intel_evidence.reference IS
  'A storage key (`<bucket>/<path>`) or external reference — never a client-supplied URL. The map path stores only a key it has proved belongs to the contributor, in one of the app''s own private media buckets. Never raw coordinates: EXIF is stripped at upload and this table must not become a second location store.';

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3360_intel_evidence_sealed_reference.sql';

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_media_reference_sealed still present after rollback.';
  END IF;
  IF to_regprocedure('public.intel_evidence_rekey_reference(uuid, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_rekey_reference still present after rollback.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3360_intel_evidence_sealed_reference.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3360 as applied after rollback.';
  END IF;
END $post$;

COMMIT;
