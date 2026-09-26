-- Rollback for 3314_memory_projection_claim_refs.sql
--
-- WHAT 3314 DID
--   * ADD COLUMN memory_projections.claim_refs uuid[] NOT NULL DEFAULT '{}'
--   * CREATE INDEX memory_projections_claim_refs_gin
--   * CREATE OR REPLACE project_user_memory_with_retraction: 2195's body plus
--     one predicate exempting subject_type = 'experience_session' from the
--     support-watermark retraction.
--
-- WHAT THIS ROLLBACK DOES, AND WHAT IT REFUSES
-- Restores 2195's retraction body, then drops the index and the column — but
-- only while NO session memory exists. With one present, rolling back would do
-- two things silently: the restored watermark would retract every session
-- memory on the next projector pass (a product change nobody decided), and
-- dropping the column would sever the only thread from those memories back to
-- the evidence they rested on (after which no erasure could reach them). So it
-- raises instead, and the operator decides what happens to those rows first.
-- Idempotent once it proceeds.

BEGIN;

DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO n FROM public.memory_projections WHERE subject_type = 'experience_session';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: % session memor(y/ies) exist. Restoring 2195''s watermark would retract them on the next projector pass, and dropping claim_refs would leave them unreachable by any erasure. Decide their fate deliberately first.', n;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.project_user_memory_with_retraction(
  p_user_id uuid, p_enforce_flag boolean DEFAULT true
)
RETURNS TABLE (projected integer, retracted integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_run_started timestamptz := clock_timestamp();
  v_projected integer := 0; v_retracted integer := 0; v_enabled boolean;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN QUERY SELECT 0,0; RETURN; END IF;
  END IF;

  v_projected := public.project_user_memory(p_user_id, false)
               + public.project_inferred_preferences(p_user_id, false);

  WITH r AS (
    UPDATE public.memory_projections
    SET state = 'retracted'
    WHERE user_id = p_user_id AND state = 'active'
      AND memory_type IN ('episodic','semantic','social','place')
      AND last_projected_at < v_run_started
    RETURNING 1
  ) SELECT count(*)::int INTO v_retracted FROM r;

  RETURN QUERY SELECT v_projected, v_retracted;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) TO service_role;

DROP INDEX IF EXISTS public.memory_projections_claim_refs_gin;
ALTER TABLE public.memory_projections DROP COLUMN IF EXISTS claim_refs;

DO $$
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memory_projections' AND column_name = 'claim_refs';
  IF FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projections.claim_refs still present after rollback.';
  END IF;
END $$;

COMMIT;
-- Then: DELETE FROM public.schema_migration_ledger WHERE filename = '3314_memory_projection_claim_refs.sql';
