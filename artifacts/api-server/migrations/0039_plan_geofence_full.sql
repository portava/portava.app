-- ============================================================
-- Migration 0039: Full plan geofence feature expansion
-- ============================================================
-- Expands plan_geofences with host location controls, check-in
-- windows, visibility modes, and attendance settings.
-- Adds plan_checkins (per-member attendance status) and
-- plan_attendance_events (audit log).
-- Adds geofence_admin_settings (default/min/max radius config).
-- All writes are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- RLS is strict: accepted members + owner only.
-- ============================================================

-- ── 1. Expand plan_geofences columns ─────────────────────────────────────────

-- public_preview_level: what non-accepted viewers see
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS public_preview_level TEXT NOT NULL DEFAULT 'neighborhood'
    CHECK (public_preview_level IN ('city_only', 'neighborhood', 'venue_tagged'));

-- exact_visibility: when accepted members see exact coords
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS exact_visibility TEXT NOT NULL DEFAULT 'exact_after_acceptance'
    CHECK (exact_visibility IN ('exact_after_acceptance', 'exact_private_host_reveal'));

-- check_in_required: host can require members to check in
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS check_in_required BOOLEAN NOT NULL DEFAULT false;

-- active check-in window (host sets these)
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS check_in_window_start TIMESTAMPTZ;

ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS check_in_window_end TIMESTAMPTZ;

-- arrival_status_visible: attendees see each other's status text
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS arrival_status_visible BOOLEAN NOT NULL DEFAULT true;

-- no_show_affects_reliability: recorded for future reliability engine
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS no_show_affects_reliability BOOLEAN NOT NULL DEFAULT false;

-- human-readable location info for non-coord display
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS location_name TEXT;

ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS neighborhood TEXT;

ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS venue_name TEXT;

-- host_revealed: true when host explicitly reveals exact location
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS host_revealed BOOLEAN NOT NULL DEFAULT false;

-- UNIQUE constraint on trip_id (one geofence per trip)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_geofences_trip_id_key' AND conrelid = 'plan_geofences'::regclass
  ) THEN
    ALTER TABLE plan_geofences ADD CONSTRAINT plan_geofences_trip_id_key UNIQUE (trip_id);
  END IF;
END $$;

-- ── 2. plan_checkins — per-member attendance status ───────────────────────────

CREATE TABLE IF NOT EXISTS plan_checkins (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  geofence_id    UUID        NOT NULL REFERENCES plan_geofences(id) ON DELETE CASCADE,
  trip_id        UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'not_checked_in'
    CHECK (status IN ('not_checked_in','on_the_way','nearby','arrived','late','no_show','left')),
  checked_in_at  TIMESTAMPTZ,
  override_by    UUID        REFERENCES auth.users(id),
  override_note  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (geofence_id, user_id)
);

ALTER TABLE plan_checkins ENABLE ROW LEVEL SECURITY;

-- Accepted members + owner can read check-ins for their trip
DROP POLICY IF EXISTS chk_select_accepted ON plan_checkins;
CREATE POLICY chk_select_accepted ON plan_checkins
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trips t
      WHERE t.id = trip_id AND t.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = plan_checkins.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role = 'member'
    )
  );

-- Users can upsert/update only their own check-in row (via service role on check-in)
DROP POLICY IF EXISTS chk_insert_self ON plan_checkins;
CREATE POLICY chk_insert_self ON plan_checkins
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS chk_update_self ON plan_checkins;
CREATE POLICY chk_update_self ON plan_checkins
  FOR UPDATE USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS plan_checkins_trip_idx ON plan_checkins(trip_id);
CREATE INDEX IF NOT EXISTS plan_checkins_geofence_idx ON plan_checkins(geofence_id);

-- ── 3. plan_attendance_events — audit log ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS plan_attendance_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  geofence_id  UUID        NOT NULL REFERENCES plan_geofences(id) ON DELETE CASCADE,
  trip_id      UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL
    CHECK (event_type IN (
      'accepted_but_no_show',
      'checked_in_successfully',
      'late_check_in',
      'suspicious_check_in',
      'host_manual_override',
      'left_early'
    )),
  actor_id     UUID        REFERENCES auth.users(id),
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plan_attendance_events ENABLE ROW LEVEL SECURITY;

-- Trip owner + accepted members can read events for their trip
DROP POLICY IF EXISTS pae_select_accepted ON plan_attendance_events;
CREATE POLICY pae_select_accepted ON plan_attendance_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trips t
      WHERE t.id = trip_id AND t.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = plan_attendance_events.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role = 'member'
    )
  );

CREATE INDEX IF NOT EXISTS pae_trip_idx ON plan_attendance_events(trip_id);
CREATE INDEX IF NOT EXISTS pae_geofence_idx ON plan_attendance_events(geofence_id);
CREATE INDEX IF NOT EXISTS pae_user_idx ON plan_attendance_events(user_id);

-- ── 4. geofence_admin_settings — single-row admin config ─────────────────────

CREATE TABLE IF NOT EXISTS geofence_admin_settings (
  id                           INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_radius_m             INT  NOT NULL DEFAULT 150,
  min_radius_m                 INT  NOT NULL DEFAULT 50,
  max_radius_m                 INT  NOT NULL DEFAULT 5000,
  no_show_affects_reliability  BOOL NOT NULL DEFAULT false,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE geofence_admin_settings ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (for validating radius on client)
DROP POLICY IF EXISTS gas_select ON geofence_admin_settings;
CREATE POLICY gas_select ON geofence_admin_settings
  FOR SELECT USING (true);

-- Seed the single admin settings row
INSERT INTO geofence_admin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
