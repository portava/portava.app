-- 2188_memory_rediscovery.sql
--
-- Memory + Experience Intelligence Architecture — Rediscovery (§8).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- The audit flagged Rediscovery (§8) as the one genuinely-thin piece: the graph
-- carries a `returned_to` edge but nothing answered "what have I done, saved or
-- loved before that matters right now?" This adds that retrieval surface over the
-- memory contract.
--
-- memory_rediscover(user, city, limit) returns the user's standing memory that is
-- relevant on returning to a city: FIRST the "you were here before" episodic
-- memory of that city (case-insensitive — the graph stores both 'Lisbon' and
-- 'lisbon'), then their durable place and social memory ("places you saved",
-- "people you know"), each tagged with a reason so the surface can explain itself
-- (§8 "memory resurfacing must be explainable"). Hidden/forgotten/decayed memory
-- and already_known/not_interested subjects are excluded (§8/§17). service_role
-- only, search_path pinned (2182/2184 rule).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.memory_rediscover(
  p_user_id uuid,
  p_city    text,
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  memory_type  text,
  subject_type text,
  subject_id   text,
  content      text,
  confidence   real,
  reason       text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT mp.*,
      CASE
        WHEN mp.memory_type = 'episodic' AND mp.subject_type = 'city'
             AND lower(mp.subject_id) = lower(p_city)       THEN 'been_here_before'
        WHEN mp.memory_type = 'place'                       THEN 'you_saved'
        WHEN mp.memory_type = 'social'                      THEN 'you_know'
        ELSE 'relevant'
      END AS reason,
      -- return-to-this-city memory ranks first; then durable standing memory.
      CASE
        WHEN mp.memory_type = 'episodic' AND mp.subject_type = 'city'
             AND lower(mp.subject_id) = lower(p_city)       THEN 0
        ELSE 1
      END AS rank_bucket
    FROM public.memory_projections mp
    WHERE mp.user_id = p_user_id
      AND mp.state = 'active'
      AND (mp.valid_to IS NULL OR mp.valid_to > now())
      AND (
        (mp.memory_type = 'episodic' AND mp.subject_type = 'city' AND lower(mp.subject_id) = lower(p_city))
        OR mp.memory_type IN ('place', 'social')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.memory_feedback f
        WHERE f.user_id = p_user_id
          AND ( (f.projection_id = mp.id)
                OR (f.subject_type = mp.subject_type AND f.subject_id = mp.subject_id) )
          AND f.kind IN ('hide','forget','already_known','not_interested')
      )
  )
  SELECT c.memory_type, c.subject_type, c.subject_id, c.content, c.confidence, c.reason
  FROM candidate c
  ORDER BY c.rank_bucket, c.confidence DESC, c.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

REVOKE ALL ON FUNCTION public.memory_rediscover(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_rediscover(uuid, text, integer) TO service_role;

COMMENT ON FUNCTION public.memory_rediscover(uuid, text, integer) IS
  'Rediscovery (spec §8): on returning to a city, surface the user''s prior memory that matters now — "you were here before" first, then durable place/social memory, each with a reason. Excludes hidden/forgotten/already_known. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.memory_rediscover(uuid, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_rediscover not created';
  END IF;
  IF has_function_privilege('anon','public.memory_rediscover(uuid, text, integer)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_rediscover reachable by anon';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_rediscover(uuid, text, integer);
