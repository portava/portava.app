-- Migration 0042: passport_stamps
-- Passport stamps (dedup by user/type/country/city), memories, contribution events,
-- visibility preferences. Feature flag seeds for passport features.

-- ── passport_stamps ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passport_stamps (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_type text        NOT NULL,
  country    text,
  city       text,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_stamps ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS passport_stamps_dedup_idx
  ON passport_stamps(user_id, stamp_type, country, city);

CREATE INDEX IF NOT EXISTS passport_stamps_user_idx ON passport_stamps(user_id);

CREATE POLICY "passport_stamps_own" ON passport_stamps
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "passport_stamps_service" ON passport_stamps
  FOR ALL TO service_role USING (true);

-- ── passport_memories: suggested→active→dismissed lifecycle ──────────────────
CREATE TABLE IF NOT EXISTS passport_memories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title      text,
  body       text,
  status     text        NOT NULL DEFAULT 'suggested'
             CHECK (status IN ('suggested', 'active', 'dismissed')),
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_memories ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS passport_memories_user_idx ON passport_memories(user_id);

CREATE POLICY "passport_memories_own" ON passport_memories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "passport_memories_service" ON passport_memories
  FOR ALL TO service_role USING (true);

-- ── passport_contribution_events: append-only log ────────────────────────────
CREATE TABLE IF NOT EXISTS passport_contribution_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type text        NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_contribution_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS passport_contribution_user_idx
  ON passport_contribution_events(user_id);

CREATE POLICY "passport_contribution_own_read" ON passport_contribution_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "passport_contribution_service" ON passport_contribution_events
  FOR ALL TO service_role USING (true);

-- ── passport_visibility_preferences ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passport_visibility_preferences (
  user_id          uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  stamps_visible   text NOT NULL DEFAULT 'public'
                   CHECK (stamps_visible IN ('public', 'circle', 'private')),
  memories_visible text NOT NULL DEFAULT 'circle'
                   CHECK (memories_visible IN ('public', 'circle', 'private')),
  map_visible      text NOT NULL DEFAULT 'public'
                   CHECK (map_visible IN ('public', 'circle', 'private')),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_visibility_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "passport_vis_prefs_own" ON passport_visibility_preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "passport_vis_prefs_service" ON passport_visibility_preferences
  FOR ALL TO service_role USING (true);

-- ── Feature flag seeds ────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('passport_stamps_enabled',       false, 'Enable passport stamps feature'),
  ('passport_memories_enabled',     false, 'Enable passport memories'),
  ('passport_map_enabled',          false, 'Show passport map view'),
  ('passport_contribution_enabled', false, 'Enable passport contributions')
ON CONFLICT (flag) DO NOTHING;
