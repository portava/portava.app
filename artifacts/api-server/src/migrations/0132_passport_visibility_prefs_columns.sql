-- 0132_passport_visibility_prefs_columns.sql
-- The visibility-preferences routes read/write default_stamp_visibility,
-- default_memory_visibility, show_city_map, show_neighborhoods,
-- show_plan_stamps and show_safe_return_stamps, but migration 0042 created
-- passport_visibility_preferences with only the legacy columns
-- (stamps_visible, memories_visible, map_visible), so every PATCH 500'd.
ALTER TABLE passport_visibility_preferences
  ADD COLUMN IF NOT EXISTS default_stamp_visibility  text NOT NULL DEFAULT 'public'
    CHECK (default_stamp_visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  ADD COLUMN IF NOT EXISTS default_memory_visibility text NOT NULL DEFAULT 'private'
    CHECK (default_memory_visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  ADD COLUMN IF NOT EXISTS show_city_map             boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_neighborhoods        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_plan_stamps          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_safe_return_stamps   boolean NOT NULL DEFAULT false;
