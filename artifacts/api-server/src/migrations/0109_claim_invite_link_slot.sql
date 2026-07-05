-- Migration 0109: Atomic invite-link slot claiming functions
--
-- Provides two SECURITY DEFINER functions called by the API server's service-role
-- client to close the TOCTOU race in the POST /invite-link/:token/accept handler.
--
-- Problem: the handler previously read use_count, checked it against max_uses, then
-- issued UPDATE SET use_count = <snapshot> + 1 as two separate DB operations.
-- Two concurrent requests that both passed the guard could both succeed, overshooting
-- max_uses by one.  Using a stale-value increment (.update({use_count: snapshot+1}))
-- also undercounts under concurrency when max_uses > 1 — both requests write the
-- same value and only one increment is recorded.
--
-- Solution: push the arithmetic into PostgreSQL so two concurrent transactions each
-- apply their own independent increment against the committed row state.
--
-- claim_invite_link_slot(link_id)
--   Increments use_count by 1 at the DB level (use_count = use_count + 1),
--   gated on (max_uses IS NULL OR use_count < max_uses).
--   Returns TRUE if a row was updated (slot successfully claimed), FALSE otherwise.
--   Returns FALSE means another concurrent request already took the last slot.
--   The API handler returns HTTP 410 when FALSE is returned.
--
-- release_invite_link_slot(link_id)
--   Decrements use_count by 1 (floors at 0) as a compensation step invoked when
--   the subsequent trip_members INSERT fails after a successful claim, preventing
--   a permanently burned slot.
--
-- SECURITY DEFINER: the functions run with the privileges of their owner rather
-- than the caller, which is required for the service-role client to mutate
-- trip_invite_links without exposing direct UPDATE access to other roles.
--
-- Privilege hardening (matches the pattern in 0089_decrement_discovery_place_saved_count):
--   • SET search_path = public prevents search_path injection attacks.
--   • REVOKE ALL FROM PUBLIC removes the default execute grant that PostgreSQL
--     applies to every new function.  Without this, any authenticated or anonymous
--     PostgREST caller could invoke these RPCs directly — bypassing route-level
--     auth checks and tampering with use_count on arbitrary links.
--   • GRANT EXECUTE TO service_role restores execute permission only for the
--     backend service account; no end-user JWT role can invoke these functions.

CREATE OR REPLACE FUNCTION public.claim_invite_link_slot(link_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE trip_invite_links
  SET use_count = use_count + 1
  WHERE id = link_id
    AND (max_uses IS NULL OR use_count < max_uses);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_invite_link_slot(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_invite_link_slot(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.release_invite_link_slot(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE trip_invite_links
  SET use_count = GREATEST(0, use_count - 1)
  WHERE id = link_id;
END;
$$;

REVOKE ALL ON FUNCTION public.release_invite_link_slot(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_invite_link_slot(uuid)
  TO service_role;
