-- ============================================================
-- 0067_moderation_actions.sql
-- Persistent log of admin / moderator actions against users or content.
-- Complements trust_restrictions (admin behavioural caps) and
-- user_account_states (lifecycle state changes).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE moderation_action_type AS ENUM (
    'warn',
    'content_remove',
    'account_limit',
    'account_suspend',
    'account_ban',
    'account_reinstate',
    'shadow_restrict',
    'trust_restrict',
    'trust_restriction_lift',
    'review_open',
    'review_close',
    'note'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_actions (
  id               uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: retain moderation record if admin account is deleted
  admin_user_id    uuid                   REFERENCES profiles(id) ON DELETE SET NULL,
  target_user_id   uuid                   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type      moderation_action_type NOT NULL,
  reason           text,
  metadata         jsonb                  NOT NULL DEFAULT '{}',
  created_at       timestamptz            NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  -- Reference to user_interaction_audit_log row for cross-linking
  audit_ref        uuid                   REFERENCES user_interaction_audit_log(id) ON DELETE SET NULL
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_moderation_actions_admin
  ON moderation_actions (admin_user_id);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_target
  ON moderation_actions (target_user_id);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_action_type
  ON moderation_actions (action_type);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_expires_at
  ON moderation_actions (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_moderation_actions_created_at
  ON moderation_actions (created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE moderation_actions ENABLE ROW LEVEL SECURITY;

-- Target user may read actions taken against them
DROP POLICY IF EXISTS "moderation_actions_select_target" ON moderation_actions;
CREATE POLICY "moderation_actions_select_target"
  ON moderation_actions FOR SELECT
  USING (target_user_id = auth.uid());

-- Admin reads: service role bypasses RLS; no additional user-facing read policy

-- All writes go through service role only

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'moderation_actions'
-- ORDER BY ordinal_position;
