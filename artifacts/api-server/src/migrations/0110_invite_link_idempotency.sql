-- Migration 0110: Invite-link join idempotency ledger
--
-- Problem: claim_invite_link_slot (migration 0109) atomically guards the slot
-- count, but if the process crashes or is killed after the slot is claimed yet
-- before trip_members is inserted (and before release_invite_link_slot runs as
-- compensation), the use_count is permanently bumped.  A retry by the same user
-- then fails at the slot guard and gets HTTP 410 even though they never joined.
--
-- Solution: a per-user attempt ledger (trip_invite_link_attempts) combined with
-- a new claim function that does two things atomically in one transaction:
--   1. If a row already exists for (link_id, user_id) → return 'already_attempted'
--      so the API handler can skip slot claiming and retry the member INSERT directly.
--   2. Otherwise: claim the slot (use_count + 1) and insert the attempt row.
--
-- The API handler deletes the attempt row on success or on compensation
-- (failed insert for a fresh claim).  When retrying a partial failure
-- (already_attempted=true) and the insert fails again with a non-unique error,
-- the attempt row is intentionally left in place so subsequent retries can
-- still skip the slot claim.

-- ---------------------------------------------------------------------------
-- Attempt ledger table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_invite_link_attempts (
  link_id    UUID        NOT NULL REFERENCES trip_invite_links(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, user_id)
);

-- Only the service-role backend should touch this table.
ALTER TABLE trip_invite_link_attempts ENABLE ROW LEVEL SECURITY;
-- No RLS policies: service_role has BYPASSRLS in Supabase and accesses via
-- the SECURITY DEFINER function below; anon/authenticated are fully blocked.

REVOKE ALL ON TABLE trip_invite_link_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE trip_invite_link_attempts TO service_role;

-- ---------------------------------------------------------------------------
-- claim_invite_link_slot_for_user(link_id, user_id)
--   Returns:
--     'already_attempted' — a prior request claimed a slot for this user but
--                           never completed; the handler should skip claiming
--                           and retry the member insert directly.
--     'claimed'           — slot successfully claimed and attempt row recorded.
--     'limit_reached'     — no slot available (max_uses exhausted).
--
-- Everything in this function executes inside a single PostgreSQL transaction,
-- so there is no window between "slot incremented" and "attempt row inserted".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_invite_link_slot_for_user(
  p_link_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_count integer;
BEGIN
  -- If an attempt row already exists this user previously claimed a slot that
  -- was never cleaned up (partial failure).  Signal the caller to retry the
  -- member insert without consuming another slot.
  IF EXISTS (
    SELECT 1 FROM trip_invite_link_attempts
    WHERE link_id = p_link_id AND user_id = p_user_id
  ) THEN
    RETURN 'already_attempted';
  END IF;

  -- Atomically increment use_count, gated on max_uses.
  UPDATE trip_invite_links
  SET use_count = use_count + 1
  WHERE id = p_link_id
    AND (max_uses IS NULL OR use_count < max_uses);

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count = 0 THEN
    RETURN 'limit_reached';
  END IF;

  -- Record the claim so a retry can detect the partial-failure state.
  INSERT INTO trip_invite_link_attempts (link_id, user_id)
  VALUES (p_link_id, p_user_id)
  ON CONFLICT DO NOTHING;

  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_invite_link_slot_for_user(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_invite_link_slot_for_user(uuid, uuid)
  TO service_role;
