-- ============================================================
-- 0068_user_interaction_cooldowns.sql
-- Generic per-actor per-target rate-limit / cooldown table.
-- Separate from availability_nudges (nudge-specific) and from
-- Compass abuse flags (Compass-scoped).
-- ============================================================

-- cooldown_type identifies the action being rate-limited
DO $$ BEGIN
  CREATE TYPE cooldown_type AS ENUM (
    'follow',
    'friend_request',
    'message_request',
    'report',
    'mute',
    'restrict',
    'block',
    'invite'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_interaction_cooldowns (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   uuid          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- target_user_id is nullable — some cooldowns are per-actor only (e.g. global
  -- report rate limit), not per-actor-target pair
  target_user_id  uuid          REFERENCES profiles(id) ON DELETE CASCADE,
  cooldown_type   cooldown_type NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  expires_at      timestamptz   NOT NULL,
  CONSTRAINT cooldowns_no_self CHECK (
    target_user_id IS NULL OR actor_user_id <> target_user_id
  )
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cooldowns_actor
  ON user_interaction_cooldowns (actor_user_id);

CREATE INDEX IF NOT EXISTS idx_cooldowns_actor_target
  ON user_interaction_cooldowns (actor_user_id, target_user_id)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cooldowns_type
  ON user_interaction_cooldowns (cooldown_type);

CREATE INDEX IF NOT EXISTS idx_cooldowns_expires_at
  ON user_interaction_cooldowns (expires_at);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_interaction_cooldowns ENABLE ROW LEVEL SECURITY;

-- Actor may read their own cooldowns
DROP POLICY IF EXISTS "cooldowns_select_actor" ON user_interaction_cooldowns;
CREATE POLICY "cooldowns_select_actor"
  ON user_interaction_cooldowns FOR SELECT
  USING (actor_user_id = auth.uid());

-- All writes go through service role only

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_interaction_cooldowns'
-- ORDER BY ordinal_position;
