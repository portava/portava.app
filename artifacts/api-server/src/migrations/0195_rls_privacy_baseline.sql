-- =============================================================================
-- 0194_rls_privacy_baseline.sql
-- Add SELECT RLS policies to profiles, trips, trip_activity_log, profile_views
--
-- Addresses privacy audit findings:
--   [C3] profiles / trips lack SELECT policies — any authenticated caller can
--        read all rows via the PostgREST REST endpoint, bypassing is_private,
--        visibility, and every API-server privacy check.
--   [L3] trip_activity_log already has a SELECT policy but it restricts reads
--        to owner/co_host roles only; extend to all accepted trip members.
--   [M5] profile_views has no SELECT policy — any authenticated caller can
--        enumerate viewer identities for any target profile.
-- =============================================================================

-- ── profiles ─────────────────────────────────────────────────────────────────
-- A caller may read a profile row if:
--   • The profile is public (is_private = false), OR
--   • The caller IS the profile owner (reading their own row)
--
-- The API server intentionally uses the service-role key, which bypasses RLS,
-- so this policy has no effect on server-driven reads. It only protects the
-- Supabase REST endpoint (/rest/v1/profiles) accessed with a user JWT.

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles
  FOR SELECT
  USING (
    is_private = false
    OR id = auth.uid()
  );

-- ── trips ────────────────────────────────────────────────────────────────────
-- A caller may read a trip row if:
--   • The trip is public (visibility = 'public'), OR
--   • The caller is the trip owner, OR
--   • The caller is an accepted trip member
--
-- Visibility values: 'public' | 'private' | 'buddies' | 'invite'
-- Non-public trips are restricted to owner + accepted members only.

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trips_select ON trips;
CREATE POLICY trips_select ON trips
  FOR SELECT
  USING (
    visibility = 'public'
    OR owner_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM   trip_members tm
      WHERE  tm.trip_id = trips.id
        AND  tm.user_id = auth.uid()
        AND  tm.status  = 'accepted'
    )
  );

-- ── trip_activity_log ────────────────────────────────────────────────────────
-- The policy added in 0079 restricted reads to owner + co_host roles only.
-- Replace it with a policy that grants access to all accepted members.
-- The API-server route still applies its own owner/co_host check on top of
-- this; the DB policy is a safety net for direct PostgREST access.

DROP POLICY IF EXISTS trip_activity_log_select ON trip_activity_log;
CREATE POLICY trip_activity_log_select ON trip_activity_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   trip_members tm
      WHERE  tm.trip_id = trip_activity_log.trip_id
        AND  tm.user_id = auth.uid()
        AND  tm.status  = 'accepted'
    )
  );

-- ── profile_views ─────────────────────────────────────────────────────────────
-- profile_views stores { target_id, viewer_id, viewed_at }.
-- Without a SELECT policy any authenticated caller can enumerate who viewed
-- any profile, exposing viewer identities that the product explicitly hides.
-- Restrict reads to the target user only (owner of the viewed profile).
-- This matches the "Never exposes viewer identity" contract in profile.ts.

ALTER TABLE profile_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_views_select ON profile_views;
CREATE POLICY profile_views_select ON profile_views
  FOR SELECT
  USING (target_id = auth.uid());
