-- 3361_intel_evidence_sealed_reference_validate.sql
-- Sensing / Map §22 evidence — close the remediation 3360 opened.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it (census-map §45).
--
-- WHAT IT DOES
--   1. REFUSES to apply while any photo/video evidence row still holds a
--      plaintext storage key. Run src/scripts/rekeyIntelEvidenceReferences.ts
--      (dry run, then --apply) first; it re-seals them through 3360's function.
--   2. VALIDATEs intel_evidence_media_reference_sealed, so the constraint is a
--      statement about every row, not only rows written after 3360.
--   3. DROPs intel_evidence_rekey_reference(uuid, text, text). It exists only to
--      lift the append-only guard for the remediation; once nothing is left to
--      re-seal, a standing SECURITY DEFINER function that can UPDATE this table
--      is surface with no purpose.
--
-- On a database where the map evidence path never wrote a row (production on
-- 2026-09-26: intel_evidence had 0 rows, docs/sensing-contributor-identity-
-- cutover-runbook.md §3), 3360 and 3361 may be applied back to back.
--
-- REVERSAL: db/rollback/2026-09-27-3361-intel-evidence-sealed-reference-validate-rollback.sql.

BEGIN;

DO $$
DECLARE
  plaintext bigint;
BEGIN
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_evidence does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_evidence_media_reference_sealed is missing. Apply 3360 first.';
  END IF;

  SELECT count(*) INTO plaintext
    FROM public.intel_evidence
   WHERE evidence_kind IN ('photo', 'video')
     AND reference IS NOT NULL
     AND reference !~ '^ievr1\.[A-Za-z0-9_-]+$';
  IF plaintext <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % photo/video evidence row(s) still hold a plaintext storage key, which names the uploader''s account. Run src/scripts/rekeyIntelEvidenceReferences.ts --apply first; this migration changed nothing.', plaintext;
  END IF;
END $$;

ALTER TABLE public.intel_evidence VALIDATE CONSTRAINT intel_evidence_media_reference_sealed;

DROP FUNCTION IF EXISTS public.intel_evidence_rekey_reference(uuid, text, text);

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_media_reference_sealed is not validated.';
  END IF;
  IF to_regprocedure('public.intel_evidence_rekey_reference(uuid, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_rekey_reference still exists.';
  END IF;
END $post$;

COMMIT;
