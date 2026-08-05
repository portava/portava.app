-- 2071_stamp_progress_atomic.sql
--
-- Atomic stamp_progress increment.
--
-- StampAwardEngine step 8 previously did a read-modify-write (select
-- progress_count → +1 → upsert), which loses increments when two awards of the
-- same repeatable definition land concurrently: both read the same count and
-- both write count+1. This RPC moves the increment into a single DB statement
-- so concurrent awards serialize on the row and every increment is kept.
--
-- stamp_progress (0081_stamp_system_v2.sql):
--   PRIMARY KEY (user_id uuid, stamp_definition_id uuid), progress_count integer
--
-- The engine calls .rpc('increment_stamp_progress', ...) and falls back to the
-- legacy upsert when this function is missing (PGRST202), so deploy order is
-- flexible. Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION increment_stamp_progress(
  p_user_id uuid,
  p_definition_id uuid
) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO stamp_progress (user_id, stamp_definition_id, progress_count, updated_at)
  VALUES (p_user_id, p_definition_id, 1, now())
  ON CONFLICT (user_id, stamp_definition_id)
  DO UPDATE SET
    progress_count = stamp_progress.progress_count + 1,
    updated_at     = now()
  RETURNING progress_count;
$$;

-- Server-side only: the API's service-role client is the sole caller.
REVOKE ALL ON FUNCTION increment_stamp_progress(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_stamp_progress(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION increment_stamp_progress(uuid, uuid) TO service_role;
