-- Migration 0038: plan_geofences RLS — require accepted-member role
--
-- The original pgf_select_member policy joined trip_members without a role
-- filter, allowing invited/pending users to read geofence rows (including
-- stored lat/lng). This migration drops and recreates the policy so only:
--   • the trip owner (trips.owner_id = auth.uid()), OR
--   • an accepted trip member (tm.role = 'member')
-- can read plan_geofences rows.
--
-- Safe to re-run: drops policy only if it exists.

DO $$ BEGIN
  -- Drop old permissive policy
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='plan_geofences' AND policyname='pgf_select_member') THEN
    DROP POLICY pgf_select_member ON plan_geofences;
  END IF;

  -- Recreate with accepted-role filter
  CREATE POLICY pgf_select_accepted ON plan_geofences FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trips WHERE trips.id = plan_geofences.trip_id
        AND (
          trips.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM trip_members tm
            WHERE tm.trip_id = trips.id
              AND tm.user_id = auth.uid()
              AND tm.role = 'member'
          )
        )
    )
  );
END $$;
