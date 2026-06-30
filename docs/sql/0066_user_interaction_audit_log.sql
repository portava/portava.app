-- ============================================================
-- 0066_user_interaction_audit_log.sql
-- Append-only audit log for all sensitive social actions.
-- Cross-domain (follow, block, mute, restrict, report, consent).
-- Rows are never updated or deleted (service role writes only).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE interaction_action_type AS ENUM (
    'follow',
    'unfollow',
    'block',
    'unblock',
    'mute',
    'unmute',
    'restrict',
    'unrestrict',
    'report',
    'friend_request_send',
    'friend_request_accept',
    'friend_request_decline',
    'friend_request_cancel',
    'consent_accept',
    'hide_recommendation'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_interaction_audit_log (
  id              uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: when an account is deleted we retain the audit row and null the FK
  actor_user_id   uuid                    REFERENCES profiles(id) ON DELETE SET NULL,
  target_user_id  uuid                    REFERENCES profiles(id) ON DELETE SET NULL,
  action_type     interaction_action_type NOT NULL,
  -- context_type / context_id identify the object the action was taken on
  -- (e.g. context_type='message', context_id='<uuid>'); both nullable for
  -- user-to-user actions with no object
  context_type    text,
  -- context_id is text (not uuid) to support legacy thread_id text values
  context_id      text,
  metadata        jsonb                   NOT NULL DEFAULT '{}',
  created_at      timestamptz             NOT NULL DEFAULT now(),
  -- Policy version string so enforcement logic changes are traceable
  policy_version  text                    NOT NULL DEFAULT '1.0'
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON user_interaction_audit_log (actor_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_target
  ON user_interaction_audit_log (target_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_action_type
  ON user_interaction_audit_log (action_type);

CREATE INDEX IF NOT EXISTS idx_audit_context
  ON user_interaction_audit_log (context_type, context_id)
  WHERE context_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_created_at
  ON user_interaction_audit_log (created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_interaction_audit_log ENABLE ROW LEVEL SECURITY;

-- Users may read only rows where they are the actor or target
DROP POLICY IF EXISTS "audit_log_select_involved" ON user_interaction_audit_log;
CREATE POLICY "audit_log_select_involved"
  ON user_interaction_audit_log FOR SELECT
  USING (
    actor_user_id  = auth.uid() OR
    target_user_id = auth.uid()
  );

-- No user INSERT — all writes go through the service role

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_interaction_audit_log'
-- ORDER BY ordinal_position;
