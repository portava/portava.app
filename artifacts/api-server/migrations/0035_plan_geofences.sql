-- Migration 0035: plan_geofences
-- Check-in radius, visibility, arrival status per plan meetup
-- Safe to re-run: IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS plan_geofences (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id               UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- coordinates stored server-side only
  lat                   DOUBLE PRECISION,
  lng                   DOUBLE PRECISION,
  check_in_radius_m     INTEGER     NOT NULL DEFAULT 150,
  -- hidden_until_accepted | accepted_members | public_approximate
  visibility            TEXT        NOT NULL DEFAULT 'hidden_until_accepted',
  -- pending | arriving | arrived | no_show | late
  arrival_status        TEXT        NOT NULL DEFAULT 'pending',
  -- host can enable/disable geofenced check-in
  host_enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by            UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pgf_trip_idx ON plan_geofences (trip_id);

ALTER TABLE plan_geofences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- Trip members can read; service role manages writes
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='plan_geofences' AND policyname='pgf_select_member') THEN
    CREATE POLICY pgf_select_member ON plan_geofences FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM trips WHERE trips.id = plan_geofences.trip_id
          AND (trips.owner_id = auth.uid()
            OR EXISTS (SELECT 1 FROM trip_members tm WHERE tm.trip_id = trips.id AND tm.user_id = auth.uid()))
      )
    );
  END IF;
END $$;
