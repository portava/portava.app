-- 2198_feature_flag_metadata_audit.sql
--
-- Give feature_flags.metadata a WRITE PATH, with the same audit guarantee the
-- boolean toggle already has.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS EXISTS
-- ---------------
-- Ruling D2=A made `metadata.mode` load-bearing: DISCOVERY_ENGINE_MODE is a
-- THREE-valued switch (legacy | shadow | pde) and feature_flags.enabled is a
-- boolean, so metadata is the only column that can carry the third value.
--
-- But nothing could write it. PATCH /admin/feature-flags/:flag validates
-- `z.object({ enabled: z.boolean() })` (routes/admin.ts:654) and calls
-- toggle_feature_flag_with_audit with p_flag/p_new_enabled/p_changed_by_id
-- (0119_toggle_flag_atomic.sql) — no metadata parameter anywhere. The mode
-- therefore could not be moved off `legacy` through any supported surface: the
-- entire Stage 2/3/4 ladder was gated behind a switch with no handle.
--
-- WHY A SEPARATE FUNCTION RATHER THAN WIDENING THE TOGGLE
-- ------------------------------------------------------
-- toggle_feature_flag_with_audit(text, boolean, uuid) is called from one place
-- and its signature is part of that contract; adding a parameter would either
-- change the signature (breaking the existing call until both sides deploy) or
-- add an overload that makes "which one did I just call" ambiguous during an
-- incident. A metadata write is also a genuinely different operation: it can
-- change what users are SERVED without changing whether the flag is on, which
-- is precisely the property that makes it need its own audit trail.
--
-- WHY THE AUDIT TABLE HAD TO GROW
-- -------------------------------
-- feature_flag_audit_log records only old_enabled/new_enabled, both NOT NULL.
-- Writing a mode change through it unchanged would produce an audit row saying
-- "false -> false" — technically true about `enabled`, and actively misleading
-- about what happened, because the serving behaviour changed completely. The
-- two new columns are NULLABLE: NULL means "metadata was not part of this
-- change" (every pre-existing row, and every ordinary toggle), which is
-- different from `'null'::jsonb` meaning "metadata was set to null".

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flag_audit_log') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flag_audit_log missing.';
  END IF;
  IF to_regprocedure('public.toggle_feature_flag_with_audit(text, boolean, uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 0119 first — this mirrors its audit contract.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='feature_flags' AND column_name='metadata') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags.metadata missing.';
  END IF;
END $$;

ALTER TABLE public.feature_flag_audit_log
  ADD COLUMN IF NOT EXISTS old_metadata jsonb,
  ADD COLUMN IF NOT EXISTS new_metadata jsonb;

COMMENT ON COLUMN public.feature_flag_audit_log.old_metadata IS
  'Metadata before the change. NULL means metadata was not part of this change (all pre-2198 rows, and every ordinary enabled-only toggle) — which is distinct from a JSON null, meaning metadata was explicitly set to null.';
COMMENT ON COLUMN public.feature_flag_audit_log.new_metadata IS
  'Metadata after the change. NULL means metadata was not part of this change.';

CREATE OR REPLACE FUNCTION public.set_feature_flag_metadata_with_audit(
  p_flag          TEXT,
  p_metadata      JSONB,
  p_changed_by_id UUID
)
RETURNS TABLE(
  flag         TEXT,
  enabled      BOOLEAN,
  description  TEXT,
  metadata     JSONB,
  updated_at   TIMESTAMPTZ,
  old_metadata JSONB,
  changed_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_old_metadata JSONB;
  v_enabled      BOOLEAN;
  v_now          TIMESTAMPTZ := NOW();
BEGIN
  -- Lock the row and read the current values atomically, exactly as 0119 does.
  SELECT ff.metadata, ff.enabled INTO v_old_metadata, v_enabled
  FROM public.feature_flags ff
  WHERE ff.flag = p_flag
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag not found: %', p_flag USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.feature_flags ff
  SET metadata = p_metadata, updated_at = v_now
  WHERE ff.flag = p_flag;

  -- Same transaction as the update, so a committed change always has its audit
  -- row. old_enabled/new_enabled are NOT NULL and carry the UNCHANGED value:
  -- this operation does not touch `enabled`, and recording the true current
  -- value in both is the honest way to say so.
  INSERT INTO public.feature_flag_audit_log
    (flag, changed_by_user_id, old_enabled, new_enabled, changed_at, old_metadata, new_metadata)
  VALUES
    (p_flag, p_changed_by_id, v_enabled, v_enabled, v_now, v_old_metadata, p_metadata);

  RETURN QUERY
    SELECT ff.flag, ff.enabled, ff.description, ff.metadata, ff.updated_at,
           v_old_metadata AS old_metadata, v_now AS changed_at
    FROM public.feature_flags ff
    WHERE ff.flag = p_flag;
END;
$fn$;

-- Same posture as 0119: admin authorization is enforced at the API layer by
-- requireAdmin; the function itself is reachable only by service_role. This
-- function can change what users are SERVED, so an anon/authenticated grant
-- here would be strictly worse than on the boolean toggle.
REVOKE ALL ON FUNCTION public.set_feature_flag_metadata_with_audit(text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_feature_flag_metadata_with_audit(text, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.set_feature_flag_metadata_with_audit(text, jsonb, uuid) IS
  'Atomically replace feature_flags.metadata and record the change in feature_flag_audit_log, mirroring toggle_feature_flag_with_audit (0119). Exists because ruling D2=A puts a three-valued mode in metadata and nothing could write it. Replaces the whole metadata object — callers must send the full document, not a patch. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.set_feature_flag_metadata_with_audit(text, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: set_feature_flag_metadata_with_audit not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='feature_flag_audit_log' AND column_name='new_metadata') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: feature_flag_audit_log.new_metadata missing';
  END IF;
  IF has_function_privilege('anon', 'public.set_feature_flag_metadata_with_audit(text, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_feature_flag_metadata_with_audit(text, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: metadata writer is reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.set_feature_flag_metadata_with_audit(text, jsonb, uuid);
--   ALTER TABLE public.feature_flag_audit_log
--     DROP COLUMN IF EXISTS old_metadata, DROP COLUMN IF EXISTS new_metadata;
--   (Dropping the columns discards the audit history of every metadata change
--    made while they existed. Prefer leaving them in place.)
