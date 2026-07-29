-- Migration: count_content_stamps_received RPC
--
-- Replaces the two-step (fetch post IDs → IN clause count) pattern in
-- ContentStampService.countContentStampsReceived with a single server-side
-- join, eliminating the N-round-trip paged loop for power users with >500
-- posts and guaranteeing an exact lifetime total in one query.
--
-- The TypeScript caller falls back to the paged loop when this function does
-- not yet exist (schema-drift safe).

CREATE OR REPLACE FUNCTION public.count_content_stamps_received(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(cs.id)
  FROM content_stamps cs
  JOIN posts p ON p.id::text = cs.entity_id
  WHERE p.author_id = p_user_id
    AND cs.entity_type IN ('post', 'media');
$$;

-- Allow authenticated users (and the service role) to call this function.
GRANT EXECUTE ON FUNCTION public.count_content_stamps_received(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_content_stamps_received(uuid) TO service_role;
