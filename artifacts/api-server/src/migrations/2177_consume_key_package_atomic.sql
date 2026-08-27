-- 2177_consume_key_package_atomic.sql
-- Atomic one-shot KeyPackage consumption (MLS key-reuse fix).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- routes/keyPackages.ts consumed a KeyPackage with a SELECT (oldest by
-- created_at) followed by a separate DELETE by id — a non-atomic
-- read-then-delete. Two concurrent consume requests for the same device both
-- ran the SELECT before either DELETE, so BOTH received the SAME
-- key_package_b64: a deterministic one-shot MLS key reuse under concurrency,
-- violating the invariant that each leaf/init KeyPackage is handed to at most one
-- group. PostgREST cannot express an atomic DELETE ... ORDER BY LIMIT RETURNING,
-- so this function does it in one statement with FOR UPDATE SKIP LOCKED, which
-- guarantees two concurrent callers claim DIFFERENT rows (or none).

CREATE OR REPLACE FUNCTION public.consume_key_package(p_device_id uuid)
RETURNS TABLE(id uuid, key_package_b64 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id  uuid;
  v_b64 text;
BEGIN
  -- Atomically claim the oldest KeyPackage for the device. The inner
  -- FOR UPDATE SKIP LOCKED locks exactly one candidate row and makes concurrent
  -- consumers skip it, so no two callers ever get the same one-shot key.
  DELETE FROM public.key_packages k
  WHERE k.id = (
    SELECT k2.id
    FROM public.key_packages k2
    WHERE k2.device_id = p_device_id
    ORDER BY k2.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING k.id, k.key_package_b64 INTO v_id, v_b64;

  IF v_id IS NULL THEN
    RETURN; -- pool empty (or every row concurrently claimed): no rows returned
  END IF;

  UPDATE public.devices d
  SET key_package_count = GREATEST(0, COALESCE(d.key_package_count, 1) - 1)
  WHERE d.id = p_device_id;

  id := v_id;
  key_package_b64 := v_b64;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_key_package(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_key_package(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.consume_key_package(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_key_package(uuid) TO service_role;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.consume_key_package(uuid);
