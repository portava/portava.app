-- 3360_intel_evidence_sealed_reference.sql
-- Sensing / Map §22 evidence — a stored evidence reference may not name an account.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it (census-map §45).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════
-- 3002 replaced intel_evidence.actor_id with a rotating contributor token so
-- that no stored contribution names a Portava account (Sensing §3, §24). The
-- map evidence path then stored, one column over, `reference = <bucket>/<path>`
-- where <path> begins with the uploader's ACCOUNT id — the id
-- lib/intelEvidenceCapture's ownership check reads back out of it. Found by
-- lane I (census-media §35.7 item 1).
--
-- The application now stores a SEALED reference instead: `ievr1.` followed by
-- base64url(iv ‖ AES-256-GCM ciphertext ‖ tag), keyed by a server secret that
-- is not in the database and bound to the row's observation_id. This file makes
-- that a property of the TABLE rather than of the one writer that exists today:
--
--   1. intel_evidence_media_reference_sealed — a CHECK that a photo or video
--      evidence row's reference is NULL or sealed. Added NOT VALID, so rows
--      written before the seal (if any exist) do not block this migration;
--      every INSERT and UPDATE from now on is checked.
--   2. intel_evidence_rekey_reference(uuid, text, text) — the ONE way to
--      replace a pre-seal plaintext key with its sealed form. The sealing key
--      is not in the database, so the database cannot do this itself; the
--      application's remediation (src/scripts/rekeyIntelEvidenceReferences.ts)
--      seals each value and calls this function once per row.
--   3. The column comment 2223 wrote ("A storage key (`<bucket>/<path>`)") is
--      replaced, because it describes the defect.
--
-- 3361 validates the constraint and drops the function once no plaintext row
-- remains. Until 3361, this function exists; after it, it does not.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THE UPDATE IS ALLOWED ON AN APPEND-ONLY TABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- intel_evidence refuses UPDATE with no escape hatch (2130), and that refusal
-- is right for a CORRECTION. A re-seal is not one: it changes how an
-- identifier is stored, not what the evidence says, exactly as 3002 §5's
-- relabelling of actor_id did. So the function follows 3002's precedent: the
-- row guard is disabled for exactly one statement and re-enabled before the
-- function returns, inside the caller's transaction. DDL takes an ACCESS
-- EXCLUSIVE lock held to commit, so no other session ever sees the guard off.
--
-- The function is narrow on purpose:
--   * the OLD value must be the row's current value (a stale caller changes
--     nothing and gets false);
--   * the OLD value must be a plaintext key in one of the two media buckets;
--   * the NEW value must have the sealed shape (and the CHECK re-checks it);
--   * one row, by primary key, and only photo or video evidence.
-- It cannot turn a sealed value back into a plaintext one, and it cannot touch
-- any other column.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORDER, AND WHAT RUNS AGAINST WHAT
-- ═══════════════════════════════════════════════════════════════════════════
-- Apply together with, or after, the application code that seals. Pre-seal
-- code writing a media evidence row against this constraint is refused with a
-- check violation and stores nothing, which is the safe failure. The map
-- evidence path is behind map_contributions_enabled (absent in production,
-- measured 2026-09-21, docs/ops/map-completion-checkpoint.md) and
-- intel_capture_quick_signal. Independent of 3002: the constraint and the
-- function read no contributor id.
--
-- REVERSAL: db/rollback/2026-09-27-3360-intel-evidence-sealed-reference-rollback.sql.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_evidence does not exist. Apply 2130 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_evidence' AND column_name = 'reference'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_evidence.reference does not exist.';
  END IF;
END $$;

-- ── 1. The constraint (NOT VALID: new writes only) ─────────────────────────
-- Added only when absent, so re-running this file after 3361 does not undo
-- 3361's validation by dropping and re-adding it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
  ) THEN
    ALTER TABLE public.intel_evidence
      ADD CONSTRAINT intel_evidence_media_reference_sealed
      CHECK (
        reference IS NULL
        OR evidence_kind NOT IN ('photo', 'video')
        OR reference ~ '^ievr1\.[A-Za-z0-9_-]+$'
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT intel_evidence_media_reference_sealed ON public.intel_evidence IS
  'A photo/video evidence reference is NULL or SEALED (ievr1.<base64url>): the storage key it hides begins with the uploader''s account id, and 3002 made this table''s contributor id a rotating token. Sealed by lib/intelEvidenceCapture with a server key that is not in the database (census-map §45).';

COMMENT ON COLUMN public.intel_evidence.reference IS
  'For photo/video evidence: a SEALED reference, ievr1.<base64url(iv|ciphertext|tag)>, bound to observation_id and openable only by the application holding INTEL_EVIDENCE_REFERENCE_KEY. It hides a storage key whose first path segment is the uploader''s account id, so it is never stored in the clear (3360). Never raw coordinates: EXIF is stripped at upload. Rows written before 3360 may hold the plaintext key until src/scripts/rekeyIntelEvidenceReferences.ts re-seals them; 3361 refuses to apply while any does.';

-- ── 2. The one-row re-seal, for rows written before the seal ────────────────
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

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $post$
DECLARE
  disabled int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_evidence'::regclass
       AND conname = 'intel_evidence_media_reference_sealed'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_media_reference_sealed is missing — a writer could still store a plaintext key.';
  END IF;

  -- The function is 3360's until 3361 closes the remediation: 3361 validates the
  -- CHECK and drops the function in one transaction (the pair 3360's rollback
  -- reads as "3361 is applied"). certify:migrations re-runs this block after
  -- 3361 has committed, so the function's absence is correct exactly then.
  IF to_regprocedure('public.intel_evidence_rekey_reference(uuid, text, text)') IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.intel_evidence'::regclass
         AND conname = 'intel_evidence_media_reference_sealed'
         AND convalidated
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: intel_evidence_rekey_reference(uuid, text, text) was not created.';
    END IF;
  ELSIF has_function_privilege('anon', 'public.intel_evidence_rekey_reference(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.intel_evidence_rekey_reference(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an end-user role can execute intel_evidence_rekey_reference.';
  END IF;

  -- This file disables no trigger itself; the function does, per call. Nothing
  -- may be left disabled at the end of the migration either way.
  SELECT count(*) INTO disabled
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public' AND rel.relname = 'intel_evidence'
     AND tg.tgname LIKE '%\_no\_update\_delete' AND tg.tgenabled = 'D';
  IF disabled <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % append-only trigger(s) on intel_evidence are DISABLED.', disabled;
  END IF;
END $post$;

COMMIT;
