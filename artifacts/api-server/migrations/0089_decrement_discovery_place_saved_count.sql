-- 0089_decrement_discovery_place_saved_count
-- Atomic helper function for decrementing discovery_places.saved_count.
--
-- Problem: the application previously computed newCount = snapshot - 1 in
-- Node.js and then issued UPDATE SET saved_count = newCount.  When two
-- different users unsave the same place concurrently, both read the same
-- saved_count snapshot, both compute the same newCount, and both overwrite
-- the DB with the same value — the count lands one step too high.
--
-- Solution: push the arithmetic into PostgreSQL using GREATEST(0, saved_count - 1).
-- PostgreSQL evaluates the expression against the committed state of the row at
-- the moment the UPDATE executes, so two concurrent transactions each apply
-- their own independent decrement in isolation — no stale read is possible.
--
-- SECURITY DEFINER: the function runs with the privileges of its owner (the
-- migration role / postgres superuser) rather than the caller.  Without this
-- the service-role API caller would need direct UPDATE access on discovery_places
-- outside of its own schema policies.
--
-- Privilege hardening (required for SECURITY DEFINER functions):
--   • SET search_path = public prevents a search_path injection attack where
--     a malicious user creates a shadow table in a schema that appears earlier
--     in the path.
--   • REVOKE ALL FROM PUBLIC removes the default execute grant that PostgreSQL
--     applies to every new function.  Without this revocation any authenticated
--     or anonymous PostgREST caller could invoke the RPC directly and decrement
--     any discovery_places row by its UUID — bypassing the route-level delete
--     and wishlist-check logic.
--   • GRANT EXECUTE TO service_role restores execute permission only for the
--     backend service account; no end-user JWT role can invoke this function.
--
-- Returns: the new saved_count value after the decrement (0 if the row did not
-- exist).  The application uses this to patch the in-memory discovery cache.

CREATE OR REPLACE FUNCTION public.decrement_discovery_place_saved_count(p_id UUID)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count integer;
BEGIN
  UPDATE discovery_places
    SET saved_count = GREATEST(0, saved_count - 1)
  WHERE id = p_id
  RETURNING saved_count INTO new_count;

  RETURN COALESCE(new_count, 0);
END;
$$;

-- Lock down execute access: revoke the implicit PUBLIC grant, then allow only
-- the service-role backend account that calls this via svc.rpc().
REVOKE ALL ON FUNCTION public.decrement_discovery_place_saved_count(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.decrement_discovery_place_saved_count(UUID)
  TO service_role;
