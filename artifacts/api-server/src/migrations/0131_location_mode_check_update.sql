-- 0131_location_mode_check_update.sql
-- PATCH /api/me/location-preferences validates locationMode against
-- ('off','city_only','nearby','live_during_activity','trusted_circle_live')
-- but the original DB CHECK only allowed ('precise','city','off'), so every
-- mode change 500'd. Widen the constraint to the API vocabulary while keeping
-- the legacy values so existing rows stay valid.
ALTER TABLE location_preferences
  DROP CONSTRAINT IF EXISTS location_preferences_location_mode_check;
ALTER TABLE location_preferences
  ADD CONSTRAINT location_preferences_location_mode_check
  CHECK (location_mode IN (
    'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live',
    -- legacy values from the original schema
    'precise', 'city'
  ));
