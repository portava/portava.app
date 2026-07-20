-- Task: stop Compass preference saves from silently failing (PGRST204)
-- PATCH /compass/me/preferences accepts these fields (all are wired to real
-- UI in the mobile Compass preferences screen), but the live
-- compass_user_preferences table was missing the columns, so any PATCH
-- containing one of them failed the whole upsert.

ALTER TABLE public.compass_user_preferences
  ADD COLUMN IF NOT EXISTS travel_styles            text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS preferred_languages      text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hidden_categories        text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS boost_visibility_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS location_privacy_mode    text    NOT NULL DEFAULT 'city_only',
  ADD COLUMN IF NOT EXISTS delayed_post_default     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visibility_sub_controls  jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS safety_preference        text    NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS rent_buddy_discoverable  boolean NOT NULL DEFAULT true;
