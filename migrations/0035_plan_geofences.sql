-- Migration 0035: plan_geofences
-- Geofence rules attached to trip plan items.

CREATE TABLE IF NOT EXISTS plan_geofences (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  plan_item_id     uuid        REFERENCES trip_plan_items(id) ON DELETE CASCADE,
  zone_id          uuid        REFERENCES geo_zones(id) ON DELETE CASCADE,
  trigger_type     text        NOT NULL DEFAULT 'enter'
                   CHECK (trigger_type IN ('enter', 'exit', 'both')),
  notify_members   boolean     NOT NULL DEFAULT true,
  message_template text,
  last_triggered_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_geofences ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS plan_geofences_trip_idx ON plan_geofences(trip_id);
CREATE INDEX IF NOT EXISTS plan_geofences_item_idx ON plan_geofences(plan_item_id);

CREATE POLICY "plan_geofences_trip_members" ON plan_geofences
  FOR ALL USING (
    EXISTS (SELECT 1 FROM trip_members WHERE trip_id = plan_geofences.trip_id AND user_id = auth.uid())
  );

CREATE POLICY "plan_geofences_service" ON plan_geofences
  FOR ALL TO service_role USING (true);
