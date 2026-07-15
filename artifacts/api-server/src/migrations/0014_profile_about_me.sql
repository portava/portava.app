-- Migration 0014: Extended "About Me" profile fields
-- Adds travel style, language, preferences, and availability columns to profiles.
-- All new columns use IF NOT EXISTS so this is safe to re-run.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS spoken_languages    TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS default_language    TEXT,
  ADD COLUMN IF NOT EXISTS travel_styles       TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS travel_pace         TEXT,
  ADD COLUMN IF NOT EXISTS budget_style        TEXT,
  ADD COLUMN IF NOT EXISTS travel_group_style  TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS looking_for         TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS comfort_level       TEXT,
  ADD COLUMN IF NOT EXISTS availability_tags   TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS planning_style      TEXT,
  ADD COLUMN IF NOT EXISTS public_social_links JSONB   DEFAULT '{}';
