-- Migration 0113: Clean up stale invite-link attempt rows
--
-- Background
-- ----------
-- Migration 0110 introduced the trip_invite_link_attempts ledger.  After a
-- successful join the accept handler calls clearAttempt() (best-effort) to
-- delete the attempt row for (link_id, user_id).  If that delete fails — due
-- to a transient network error, a process crash immediately after the
-- trip_members INSERT commits, or an unhandled exception — the attempt row
-- lingers.
--
-- Unlike stranded slots (no member row — handled by reconcile_invite_link_slots
-- in migration 0111), a stale attempt row has a MATCHING trip_members row: the
-- join succeeded but the cleanup did not.  These rows are harmless to slot
-- counts but they cause future join attempts by the same user on the same
-- link to return 'already_attempted', which triggers a redundant retry path.
-- If the user somehow leaves the trip and tries to re-join via the same link
-- they would skip the slot claim entirely and go straight to the INSERT, which
-- may fail with a 409 or succeed depending on RLS.
--
-- cleanup_stale_invite_link_attempts()
-- --------------------------------------
-- Finds trip_invite_link_attempts rows whose (link_id, user_id) pair has a
-- corresponding trip_members row for the link's trip.  For each such row it:
--   1. Deletes the stale attempt row.
--   2. Returns one result row so the caller can log/report the cleanup.
--
-- Unlike reconcile_invite_link_slots, no min-age gate is needed: if the member
-- row exists the attempt row is definitively stale regardless of age.
--
-- Concurrent calls are safe — the function issues a plain DELETE which is
-- idempotent per (link_id, user_id) primary key; no double-deletion is
-- possible.
--
-- Privilege hardening (same pattern as 0089/0109/0111):
--   SET search_path = public       — prevents search_path injection.
--   REVOKE ALL FROM PUBLIC …       — removes default PUBLIC execute grant.
--   GRANT EXECUTE TO service_role  — only the backend service account may call it.

CREATE OR REPLACE FUNCTION public.cleanup_stale_invite_link_attempts()
RETURNS TABLE (
  link_id    uuid,
  user_id    uuid,
  claimed_at timestamptz,
  trip_id    uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    DELETE FROM trip_invite_link_attempts a
    USING trip_invite_links til
    WHERE a.link_id = til.id
      AND EXISTS (
        SELECT 1
        FROM trip_members tm
        WHERE tm.trip_id = til.trip_id
          AND tm.user_id  = a.user_id
      )
    RETURNING
      a.link_id,
      a.user_id,
      a.claimed_at,
      til.trip_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_invite_link_attempts()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_invite_link_attempts()
  TO service_role;
