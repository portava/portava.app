-- 0107_compass_analytics_onboarding.sql
-- Adds compass_analytics_events table and extends compass_settings
-- with onboarding_completed and use_chosen_city fields.

-- Extend compass_settings
ALTER TABLE compass_settings
  ADD COLUMN IF NOT EXISTS use_chosen_city         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS onboarding_completed    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- Lightweight analytics event log for Compass surfaces
CREATE TABLE IF NOT EXISTS compass_analytics_events (
  id                     uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_name             text        NOT NULL CHECK (char_length(event_name) <= 120),
  compass_engine_version text,
  item_id                text,
  item_type              text,
  section_name           text,
  city                   text,
  metadata               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compass_analytics_user_id
  ON compass_analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_compass_analytics_event_name
  ON compass_analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_compass_analytics_created_at
  ON compass_analytics_events(created_at DESC);

-- RLS: users can only insert their own events (no read-back for now)
ALTER TABLE compass_analytics_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_analytics_events'
      AND policyname = 'compass_analytics_events_insert'
  ) THEN
    EXECUTE $p$
      CREATE POLICY compass_analytics_events_insert
        ON compass_analytics_events FOR INSERT
        WITH CHECK (auth.uid() = user_id)
    $p$;
  END IF;
END $$;
