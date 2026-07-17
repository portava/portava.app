-- Migration 0146: append-only fallback for recording orphaned cleanup paths
--
-- persistCleanupError normally reads cleanup_error_paths, merges, and writes
-- back. When the read fails (DB read outage) the merge base is unknown, so the
-- worker cannot safely write the combined list. This SQL function appends the
-- new paths atomically server-side (no client read needed), so orphaned file
-- paths survive a read outage + worker restart instead of living only in logs.

CREATE OR REPLACE FUNCTION append_stamp_cleanup_error_paths(
  p_job_id uuid,
  p_error  text,
  p_paths  text[]
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  UPDATE stamp_generation_queue
  SET cleanup_error       = p_error,
      cleanup_error_paths = (
        SELECT COALESCE(array_agg(DISTINCT p), '{}')
        FROM unnest(COALESCE(cleanup_error_paths, '{}') || COALESCE(p_paths, '{}')) AS p
      ),
      updated_at          = now()
  WHERE id = p_job_id;
$fn$;

REVOKE ALL ON FUNCTION append_stamp_cleanup_error_paths(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION append_stamp_cleanup_error_paths(uuid, text, text[]) TO service_role;
