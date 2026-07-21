-- Phase 11: Compass Sense — presence settings + durable nudge log.

CREATE TABLE IF NOT EXISTS compass_sense_settings (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  presence_level TEXT NOT NULL DEFAULT 'passive'
                 CHECK (presence_level IN ('passive', 'aware', 'active')),
  categories     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compass_sense_nudges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nudge_type TEXT NOT NULL,
  category   TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  action_url TEXT,
  confidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sense_nudges_user_created
  ON compass_sense_nudges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sense_nudges_user_dedupe
  ON compass_sense_nudges (user_id, dedupe_key, created_at DESC);

ALTER TABLE compass_sense_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE compass_sense_nudges   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sense_settings_own ON compass_sense_settings;
CREATE POLICY sense_settings_own ON compass_sense_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS sense_nudges_own_read ON compass_sense_nudges;
CREATE POLICY sense_nudges_own_read ON compass_sense_nudges
  FOR SELECT USING (auth.uid() = user_id);
