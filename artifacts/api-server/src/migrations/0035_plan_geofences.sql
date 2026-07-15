-- Migration: 0035_plan_geofences.sql
-- Creates plan_geofences linking plan items to geo zones.

CREATE TYPE IF NOT EXISTS geofence_trigger_type AS ENUM (
  'enter', 'exit', 'dwell'
);

CREATE TABLE IF NOT EXISTS plan_geofences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  plan_item_id     uuid REFERENCES trip_plan_items(id) ON DELETE CASCADE,
  zone_id          uuid NOT NULL REFERENCES geo_zones(id) ON DELETE CASCADE,
  trigger_type     geofence_trigger_type NOT NULL DEFAULT 'enter',
  notify_members   boolean NOT NULL DEFAULT true,
  message_template text,
  last_triggered_at timestamptz
);

ALTER TABLE plan_geofences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trip_members_manage_geofences" ON plan_geofences
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = plan_geofences.trip_id
        AND tm.user_id = auth.uid()
    )
  );
