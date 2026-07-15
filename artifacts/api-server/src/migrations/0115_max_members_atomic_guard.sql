-- Migration 0115: Enforce max_members atomically via a BEFORE INSERT trigger
--
-- Problem:
--   The accept handler has two independent capacity guards:
--     1. An optimistic JS pre-flight that reads COUNT(trip_members) before any DB
--        write — two concurrent requests both see the count as under-capacity.
--     2. claim_invite_link_slot_for_user — gates on max_uses atomically within its
--        own transaction, but that transaction commits (releasing any lock) before
--        the subsequent trip_members INSERT runs in a separate Supabase request.
--        Two users can therefore both receive 'claimed' and both proceed to insert,
--        exceeding max_members.
--
-- Fix:
--   A BEFORE INSERT (and BEFORE UPDATE OF status) trigger on trip_members that:
--     1. Acquires a row-level FOR UPDATE lock on the trips row within the same
--        INSERT transaction — serialising concurrent inserts for the same trip.
--     2. Counts the current accepted members inside that transaction.
--     3. Raises a PG exception (SQLSTATE P0001, message 'trip_full') if the cap
--        is reached, rolling back the INSERT atomically.
--
--   Because the lock, count, and insert all occur in a single PostgreSQL
--   transaction, no two concurrent inserts can both see the count as under-capacity.
--
--   The API handler catches the P0001/'trip_full' error from the failed INSERT,
--   releases the invite slot (so use_count is not permanently bumped), and returns
--   HTTP 410 with { error: "gone", reason: "trip_full" }.
--
-- Complementary optimisation (claim_invite_link_slot_for_user):
--   The claim function also checks max_members (returning 'trip_full' before any
--   slot is consumed) as a fast-path to skip the INSERT entirely when the trip is
--   already obviously full.  This optimisation is correct only for the point-in-time
--   read inside its own transaction; the trigger is the authoritative atomic guard
--   for concurrent inserts that race between claim and insert.
--
-- Apply:
--   Run this SQL in the Supabase SQL editor or via psql against the project DB.
--
-- Verify:
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trip_members_max_members_guard';
--   SELECT prosrc FROM pg_proc WHERE proname = 'enforce_trip_max_members';

-- ---------------------------------------------------------------------------
-- Trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_trip_max_members()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_members  integer;
  v_member_count bigint;
BEGIN
  -- Only enforce for accepted memberships — pending/declined rows don't count.
  IF NEW.status <> 'accepted' THEN
    RETURN NEW;
  END IF;

  -- Lock the trip row for the duration of this transaction.
  -- Two concurrent INSERTs for the same trip will serialize here; the second
  -- waits until the first has committed (or rolled back) before proceeding.
  -- This ensures the COUNT below always sees the committed member set.
  SELECT max_members INTO v_max_members
  FROM trips
  WHERE id = NEW.trip_id
  FOR UPDATE;

  -- No cap set — allow unconditionally.
  IF v_max_members IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_member_count
  FROM trip_members
  WHERE trip_id = NEW.trip_id
    AND status  = 'accepted';

  -- BEFORE trigger: NEW row is not yet in the table, so the count reflects the
  -- committed state.  If count is already at cap, reject the insert.
  IF v_member_count >= v_max_members THEN
    RAISE EXCEPTION 'trip_full'
      USING ERRCODE = 'P0001',
            DETAIL  = 'max_members cap reached for trip ' || NEW.trip_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Only the service-role backend inserts into trip_members; no direct access for
-- other roles, so no additional REVOKE/GRANT is needed for the trigger function.
-- The trigger fires automatically as part of the INSERT/UPDATE transaction.

-- ---------------------------------------------------------------------------
-- Attach the trigger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trip_members_max_members_guard ON public.trip_members;

CREATE TRIGGER trip_members_max_members_guard
  BEFORE INSERT OR UPDATE OF status
  ON public.trip_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_trip_max_members();

-- ---------------------------------------------------------------------------
-- Update claim_invite_link_slot_for_user with the trip_full fast-path
--
-- This is an optimisation only: if the trip is already at capacity when the
-- claim is attempted, return 'trip_full' immediately without consuming a slot.
-- It does NOT close the race (the lock is released when the function returns),
-- but it avoids unnecessary INSERT attempts and slot-release roundtrips when
-- the trip is clearly full at the time of the claim.
-- The trigger above is the authoritative atomic guard.
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
  v_trip_id       uuid;
  v_max_members   integer;
  v_member_count  bigint;
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

  -- Fast-path: if the trip already has max_members accepted members, skip the
  -- slot claim and INSERT attempt entirely.  This is a point-in-time read
  -- inside this transaction — it is an optimisation, not the atomic guard.
  -- The BEFORE INSERT trigger on trip_members is the authoritative gate.
  SELECT l.trip_id, t.max_members
  INTO   v_trip_id, v_max_members
  FROM   trip_invite_links l
  JOIN   trips t ON t.id = l.trip_id
  WHERE  l.id = p_link_id;

  IF NOT FOUND THEN
    -- Link deleted between handler's SELECT and here; treat as no slot.
    RETURN 'limit_reached';
  END IF;

  IF v_max_members IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count
    FROM   trip_members
    WHERE  trip_id = v_trip_id
      AND  status  = 'accepted';

    IF v_member_count >= v_max_members THEN
      RETURN 'trip_full';
    END IF;
  END IF;

  -- Atomically increment use_count, gated on max_uses.
  UPDATE trip_invite_links
  SET    use_count = use_count + 1
  WHERE  id = p_link_id
    AND  (max_uses IS NULL OR use_count < max_uses);

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
