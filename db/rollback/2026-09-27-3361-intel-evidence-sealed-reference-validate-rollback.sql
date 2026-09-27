-- Rollback for 3361_intel_evidence_sealed_reference_validate.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3361 DID
-- =============
--   * VALIDATE CONSTRAINT intel_evidence_media_reference_sealed;
--   * DROP FUNCTION public.intel_evidence_rekey_reference(uuid, text, text).
--   No row was written.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores exactly the state 3360 left: the constraint NOT VALID (dropped and
-- re-added with the same expression, since Postgres cannot un-validate), and
-- the function re-created byte-for-byte from 3360 with the same grants. A
-- validated and a NOT VALID CHECK refuse the same new writes; the difference
-- this restores is only that the constraint no longer asserts anything about
-- rows written before it.
--
-- It changes no row. Sealed references stay sealed (see the 3360 rollback for
-- why nothing may un-seal them).
--
-- It deletes 3361's schema_migration_ledger row (the runner writes it in the
-- file's own transaction), so a later run of scripts/src/apply-migrations.ts
-- re-applies 3361 instead of taking it as applied (census-map §45.11).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_evidence does not exist.';
  END IF;
END $$;

ALTER TABLE public.intel_evidence
  DROP CONSTRAINT IF EXISTS intel_evidence_media_reference_sealed;
ALTER TABLE public.intel_evidence
  ADD CONSTRAINT intel_evidence_media_reference_sealed
  CHECK (
    reference IS NULL
    OR evidence_kind NOT IN ('photo', 'video')
    OR reference ~ '^ievr1\.[A-Za-z0-9_-]+$'
  ) NOT VALID;

COMMENT ON CONSTRAINT intel_evidence_media_reference_sealed ON public.intel_evidence IS
  'A photo/video evidence reference is NULL or SEALED (ievr1.<base64url>): the storage key it hides begins with the uploader''s account id, and 3002 made this table''s contributor id a rotating token. Sealed by lib/intelEvidenceCapture with a server key that is not in the database (census-map §45).';

-- ── The function, as 3360 created it ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.intel_evidence_rekey_reference(
  p_evidence_id uuid,
  p_legacy_reference text,
  p_sealed_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current text;
  v_kind    text;
  v_guarded boolean;
  n         bigint;
BEGIN
  IF p_evidence_id IS NULL OR p_legacy_reference IS NULL OR p_sealed_reference IS NULL THEN
    RAISE EXCEPTION 'intel_evidence_rekey_reference: every argument is required';
  END IF;
  -- The only transition this function performs: plaintext media key -> sealed.
  IF p_legacy_reference !~ '^(post-media|profile-media)/' THEN
    RAISE EXCEPTION 'intel_evidence_rekey_reference: the old value is not a plaintext media storage key';
  END IF;
  IF p_sealed_reference !~ '^ievr1\.[A-Za-z0-9_-]{40,}$' THEN
    RAISE EXCEPTION 'intel_evidence_rekey_reference: the new value is not a sealed reference';
  END IF;

  SELECT e.reference, e.evidence_kind
    INTO v_current, v_kind
    FROM public.intel_evidence e
   WHERE e.id = p_evidence_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_kind NOT IN ('photo', 'video') OR v_current IS DISTINCT FROM p_legacy_reference THEN
    -- Another run re-sealed it, or the caller read a different row. Change nothing.
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger tg
      JOIN pg_class rel ON rel.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND rel.relname = 'intel_evidence'
       AND tg.tgname = 'intel_evidence_no_update_delete' AND NOT tg.tgisinternal
  ) INTO v_guarded;

  IF v_guarded THEN
    ALTER TABLE public.intel_evidence DISABLE TRIGGER intel_evidence_no_update_delete;
  END IF;
  UPDATE public.intel_evidence
     SET reference = p_sealed_reference
   WHERE id = p_evidence_id
     AND reference = p_legacy_reference;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF v_guarded THEN
    ALTER TABLE public.intel_evidence ENABLE TRIGGER intel_evidence_no_update_delete;
  END IF;

  RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_evidence_rekey_reference(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_evidence_rekey_reference(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.intel_evidence_rekey_reference(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_evidence_rekey_reference(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.intel_evidence_rekey_reference(uuid, text, text) IS
  'Remediation for census-map §45: replaces ONE photo/video evidence row''s pre-3360 plaintext storage key with its sealed form, only if the row still holds exactly that plaintext value. Lifts the append-only row guard for that one UPDATE and restores it before returning, as 3002 §5 did for actor_id. service_role only. Dropped by 3361.';

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3361_intel_evidence_sealed_reference_validate.sql';

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
       AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_media_reference_sealed is not back to NOT VALID.';
  END IF;
  IF to_regprocedure('public.intel_evidence_rekey_reference(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_rekey_reference was not re-created.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3361_intel_evidence_sealed_reference_validate.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3361 as applied after rollback.';
  END IF;
END $post$;

COMMIT;
