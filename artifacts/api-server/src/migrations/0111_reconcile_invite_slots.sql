-- Migration 0111: Invite-link slot reconciliation function
--
-- Background
-- ----------
-- Migration 0109 added claim_invite_link_slot / release_invite_link_slot.
-- Migration 0110 added claim_invite_link_slot_for_user and the per-user attempt
-- ledger (trip_invite_link_attempts).
--
-- The accept handler calls claim_invite_link_slot_for_user (incrementing
-- use_count and writing a trip_invite_link_attempts row atomically) and then
-- inserts a trip_members row.  If release_invite_link_slot fails — or if the
-- process is killed between the claim and the INSERT — the slot stays stranded:
--   • use_count is bumped in trip_invite_links
--   • a trip_invite_link_attempts row exists for (link_id, user_id)
--   • no trip_members row exists for (trip_id, user_id)
--
-- This function finds and fixes all such stranded slots in one round-trip,
-- making it safe to call repeatedly (idempotent).
--
-- reconcile_invite_link_slots(min_age_minutes)
-- --------------------------------------------
-- Scans trip_invite_link_attempts for rows whose claimed_at is older than
-- min_age_minutes (default 5) and whose user never ended up in trip_members
-- for the associated trip.  For each stranded slot it:
--   1. Decrements use_count by 1 (floors at 0) in trip_invite_links.
--   2. Deletes the orphaned trip_invite_link_attempts row.
--   3. Returns one result row so the caller can log/report the fix.
--
-- The age gate (default 5 minutes) ensures in-flight legitimate requests —
-- which may still be between the claim and the INSERT — are never touched.
-- Concurrent reconciliation runs are safe because the function uses
-- FOR UPDATE SKIP LOCKED on trip_invite_link_attempts to avoid double-fixing.
--
-- Privilege hardening (same pattern as 0089/0109):
--   SET search_path = public       — prevents search_path injection.
--   REVOKE ALL FROM PUBLIC …       — removes default PUBLIC execute grant.
--   GRANT EXECUTE TO service_role  — only the backend service account may call it.

CREATE OR REPLACE FUNCTION public.reconcile_invite_link_slots(
  min_age_minutes integer DEFAULT 5
)
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
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT
      a.link_id,
      a.user_id,
      a.claimed_at,
      til.trip_id
    FROM trip_invite_link_attempts a
    JOIN trip_invite_links til ON til.id = a.link_id
    WHERE a.claimed_at < now() - (min_age_minutes || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1
        FROM trip_members tm
        WHERE tm.trip_id = til.trip_id
          AND tm.user_id = a.user_id
      )
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    -- Decrement use_count for this specific link (one decrement per stranded slot)
    UPDATE trip_invite_links
    SET use_count = GREATEST(0, use_count - 1)
    WHERE id = v_row.link_id;

    -- Remove the orphaned attempt row so retries no longer skip the slot guard
    DELETE FROM trip_invite_link_attempts
    WHERE link_id = v_row.link_id
      AND user_id = v_row.user_id;

    -- Yield this fixed slot to the caller
    link_id    := v_row.link_id;
    user_id    := v_row.user_id;
    claimed_at := v_row.claimed_at;
    trip_id    := v_row.trip_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_invite_link_slots(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_invite_link_slots(integer)
  TO service_role;
