-- Find Your Circle — Migration 0119
-- Per-member visibility overrides within a context.
-- Lets a user hide a specific person from their circle view, or hide themselves
-- from a specific person, within a given context (trip or event).

CREATE TABLE IF NOT EXISTS circle_member_visibility_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  -- hide_from_me:    hide target from appearing in viewer's circle members list.
  -- hide_me_from:    hide viewer (user_id) from appearing in target's circle members list.
  direction       TEXT NOT NULL CHECK (direction IN ('hide_from_me', 'hide_me_from')),
  hidden          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id, context_type, context_id, direction)
);

CREATE INDEX IF NOT EXISTS cmvo_user_context_idx
  ON circle_member_visibility_overrides (user_id, context_type, context_id);

CREATE INDEX IF NOT EXISTS cmvo_target_context_idx
  ON circle_member_visibility_overrides (target_user_id, context_type, context_id);

ALTER TABLE circle_member_visibility_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmvo_owner_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_owner_all ON circle_member_visibility_overrides
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cmvo_service_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_service_all ON circle_member_visibility_overrides
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
