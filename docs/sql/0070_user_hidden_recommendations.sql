-- ============================================================
-- 0070_user_hidden_recommendations.sql
-- Durable, user-intentional "hide this person from my suggestions" table.
-- Distinct from compass_user_preferences.ignored_item_ids (ephemeral
-- feed suppression) and user_suggestion_seen (recency dedup).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE recommendation_direction AS ENUM (
    -- The caller hides the target from their own suggestion feed
    'outbound',
    -- The caller asks not to appear in the target's suggestions (not implemented in
    -- Phase 3 permission engine; stored for future policy use)
    'inbound'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_hidden_recommendations (
  id              uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid                     NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hidden_user_id  uuid                     NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  direction       recommendation_direction NOT NULL DEFAULT 'outbound',
  created_at      timestamptz              NOT NULL DEFAULT now(),
  CONSTRAINT hidden_recommendations_unique UNIQUE (user_id, hidden_user_id, direction),
  CONSTRAINT hidden_recommendations_no_self CHECK (user_id <> hidden_user_id)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_hidden_recs_user_id
  ON user_hidden_recommendations (user_id);

CREATE INDEX IF NOT EXISTS idx_hidden_recs_hidden_user_id
  ON user_hidden_recommendations (hidden_user_id);

CREATE INDEX IF NOT EXISTS idx_hidden_recs_pair
  ON user_hidden_recommendations (user_id, hidden_user_id);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_hidden_recommendations ENABLE ROW LEVEL SECURITY;

-- Users read only rows they own
DROP POLICY IF EXISTS "hidden_recs_select_own" ON user_hidden_recommendations;
CREATE POLICY "hidden_recs_select_own"
  ON user_hidden_recommendations FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_recs_insert_own" ON user_hidden_recommendations;
CREATE POLICY "hidden_recs_insert_own"
  ON user_hidden_recommendations FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_recs_delete_own" ON user_hidden_recommendations;
CREATE POLICY "hidden_recs_delete_own"
  ON user_hidden_recommendations FOR DELETE
  USING (user_id = auth.uid());

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_hidden_recommendations'
-- ORDER BY ordinal_position;
