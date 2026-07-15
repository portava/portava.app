-- Find Your Circle — Migration 0121
-- Immutable audit log for all significant Circle events.
-- Written by the API server (service role) for: sharing enabled/disabled,
-- visibility mode changed, paused/resumed, check-in created, needs-help triggered,
-- admin disabled context, host changed meeting point, consent accepted,
-- admin kill switch toggled.

CREATE TABLE IF NOT EXISTS circle_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for system/cron events.
  actor_user_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- NULL when event is not targeted at a specific user.
  target_user_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  context_type    TEXT CHECK (context_type IN ('trip', 'event')),
  context_id      UUID,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'sharing_enabled',
    'sharing_disabled',
    'visibility_mode_changed',
    'presence_paused',
    'presence_resumed',
    'checkin_created',
    'needs_help_triggered',
    'admin_disabled_context',
    'host_changed_meeting_point',
    'consent_accepted',
    'admin_kill_switch_toggled'
  )),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cae_actor_idx
  ON circle_audit_events (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cae_target_idx
  ON circle_audit_events (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cae_context_idx
  ON circle_audit_events (context_type, context_id, created_at DESC)
  WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cae_event_type_idx
  ON circle_audit_events (event_type, created_at DESC);

ALTER TABLE circle_audit_events ENABLE ROW LEVEL SECURITY;

-- Actors and targets can read their own audit rows; service role writes all.
DROP POLICY IF EXISTS cae_actor_read ON circle_audit_events;
CREATE POLICY cae_actor_read ON circle_audit_events
  FOR SELECT
  USING (actor_user_id = auth.uid() OR target_user_id = auth.uid());

DROP POLICY IF EXISTS cae_service_all ON circle_audit_events;
CREATE POLICY cae_service_all ON circle_audit_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
