-- Migration 0039: plan_geofence_full
-- Expands plan_geofences with attendance/visibility columns + UNIQUE trip_id.
-- Adds plan_checkins, plan_attendance_events, geofence_admin_settings.

-- ── Expand plan_geofences ─────────────────────────────────────────────────────
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS public_preview_level       text,
  ADD COLUMN IF NOT EXISTS exact_visibility           text,
  ADD COLUMN IF NOT EXISTS check_in_required          boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS window_start               timestamptz,
  ADD COLUMN IF NOT EXISTS window_end                 timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_status_visible     boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS no_show_affects_reliability boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS location_name              text,
  ADD COLUMN IF NOT EXISTS city                       text,
  ADD COLUMN IF NOT EXISTS neighborhood               text,
  ADD COLUMN IF NOT EXISTS venue_name                 text,
  ADD COLUMN IF NOT EXISTS host_revealed              boolean     NOT NULL DEFAULT false;

-- UNIQUE on trip_id (one geofence config per trip)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plan_geofences' AND constraint_name = 'plan_geofences_trip_id_unique'
  ) THEN
    ALTER TABLE plan_geofences ADD CONSTRAINT plan_geofences_trip_id_unique UNIQUE (trip_id);
  END IF;
END $$;

-- ── plan_checkins: per-member attendance status ───────────────────────────────
CREATE TABLE IF NOT EXISTS plan_checkins (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_geofence_id  uuid        NOT NULL REFERENCES plan_geofences(id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'arrived', 'no_show', 'excused')),
  checked_in_at     timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_geofence_id, user_id)
);

ALTER TABLE plan_checkins ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS plan_checkins_geofence_idx ON plan_checkins(plan_geofence_id);
CREATE INDEX IF NOT EXISTS plan_checkins_user_idx     ON plan_checkins(user_id);

CREATE POLICY "plan_checkins_service" ON plan_checkins
  FOR ALL TO service_role USING (true);

CREATE POLICY "plan_checkins_trip_member_read" ON plan_checkins
  FOR SELECT USING (
    user_id = auth.uid() OR EXISTS (
      SELECT 1 FROM plan_geofences pg
      JOIN trip_members tm ON tm.trip_id = pg.trip_id
      WHERE pg.id = plan_geofence_id AND tm.user_id = auth.uid()
    )
  );

-- ── plan_attendance_events: audit log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_attendance_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_geofence_id  uuid        NOT NULL REFERENCES plan_geofences(id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type        text        NOT NULL
                    CHECK (event_type IN ('suspicious', 'late', 'override', 'excused')),
  details           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_attendance_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS plan_attendance_geofence_idx ON plan_attendance_events(plan_geofence_id);
CREATE INDEX IF NOT EXISTS plan_attendance_user_idx     ON plan_attendance_events(user_id);

CREATE POLICY "plan_attendance_service" ON plan_attendance_events
  FOR ALL TO service_role USING (true);

-- ── geofence_admin_settings: single-row global config ────────────────────────
CREATE TABLE IF NOT EXISTS geofence_admin_settings (
  id                    integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_radius_meters integer     NOT NULL DEFAULT 200,
  min_radius_meters     integer     NOT NULL DEFAULT 50,
  max_radius_meters     integer     NOT NULL DEFAULT 5000,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geofence_admin_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "geofence_admin_public_read" ON geofence_admin_settings
  FOR SELECT USING (true);

CREATE POLICY "geofence_admin_service" ON geofence_admin_settings
  FOR ALL TO service_role USING (true);

INSERT INTO geofence_admin_settings (id, default_radius_meters, min_radius_meters, max_radius_meters)
VALUES (1, 200, 50, 5000)
ON CONFLICT (id) DO NOTHING;
