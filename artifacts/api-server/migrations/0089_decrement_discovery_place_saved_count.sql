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
-- SECURITY DEFINER: the function runs with the privileges of its owner (service
-- role), not the caller.  This is safe because the function only touches a
-- single column of a single row identified by UUID, and only decrements — it
-- cannot expose or modify any other data.
--
-- Returns: the new saved_count value after the decrement (0 if the row did not
-- exist).  The application uses this to patch the in-memory discovery cache.

CREATE OR REPLACE FUNCTION decrement_discovery_place_saved_count(p_id UUID)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
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
