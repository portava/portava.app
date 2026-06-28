-- Migration 0062: Full notifications schema
--
-- Creates all tables required by the push notification pipeline:
--   notifications               — in-app notification rows (Activity Center)
--   notification_devices        — per-device Expo push tokens
--   notification_preferences    — per-user global delivery preferences
--   notification_category_prefs — per-user per-category overrides
--   notification_delivery_attempts — audit log of every dispatch attempt
--   push_retry_queue            — transient-failure retry queue
--   activity_events             — raw activity event log
--
-- Without these tables POST /api/me/devices (token registration) fails with a
-- DB error, meaning push notifications never reach dev-build / standalone users.

-- ── notifications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  priority      TEXT        NOT NULL DEFAULT 'normal',
  title         TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  action_url    TEXT,
  image_url     TEXT,
  source_type   TEXT,
  source_id     TEXT,
  actor_id      UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  privacy_level TEXT        NOT NULL DEFAULT 'standard',
  read_at       TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications(user_id, read_at)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_expires_at_idx
  ON public.notifications(expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

-- Service role handles all writes (create, mark-read, dismiss, expire)

-- ── notification_devices ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_devices (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_token   TEXT        NOT NULL,
  platform     TEXT        NOT NULL DEFAULT 'expo',
  label        TEXT,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, push_token)
);

CREATE INDEX IF NOT EXISTS notification_devices_user_idx
  ON public.notification_devices(user_id);

ALTER TABLE public.notification_devices ENABLE ROW LEVEL SECURITY;

-- Service role manages all writes; users can read their own device rows
CREATE POLICY "notification_devices_select_own"
  ON public.notification_devices FOR SELECT
  USING (auth.uid() = user_id);

-- ── notification_preferences ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id            UUID        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  email_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  in_app_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  digests_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  safety_override    BOOLEAN     NOT NULL DEFAULT TRUE,
  quiet_hours_enabled BOOLEAN    NOT NULL DEFAULT FALSE,
  quiet_start        TEXT        NOT NULL DEFAULT '22:00',
  quiet_end          TEXT        NOT NULL DEFAULT '08:00',
  message_previews   BOOLEAN     NOT NULL DEFAULT TRUE,
  location_previews  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_prefs_select_own"
  ON public.notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "notification_prefs_insert_own"
  ON public.notification_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "notification_prefs_update_own"
  ON public.notification_preferences FOR UPDATE
  USING (auth.uid() = user_id);

-- ── notification_category_preferences ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_category_preferences (
  user_id        UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category       TEXT        NOT NULL,
  in_app_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
  push_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  email_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  digest_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE public.notification_category_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_cat_prefs_select_own"
  ON public.notification_category_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "notification_cat_prefs_insert_own"
  ON public.notification_category_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "notification_cat_prefs_update_own"
  ON public.notification_category_preferences FOR UPDATE
  USING (auth.uid() = user_id);

-- ── notification_delivery_attempts ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID        REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel         TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_notif_idx
  ON public.notification_delivery_attempts(notification_id);

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_user_created_idx
  ON public.notification_delivery_attempts(user_id, created_at DESC);

ALTER TABLE public.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;

-- Service role reads all (admin dashboards); no user-facing reads needed
-- Users cannot read raw delivery attempts directly

-- ── push_retry_queue ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_retry_queue (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id      UUID        REFERENCES public.notifications(id) ON DELETE SET NULL,
  delivery_attempt_id  UUID        REFERENCES public.notification_delivery_attempts(id) ON DELETE SET NULL,
  user_id              UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tokens               TEXT[]      NOT NULL DEFAULT '{}',
  payload              JSONB       NOT NULL DEFAULT '{}',
  attempt_count        INT         NOT NULL DEFAULT 1,
  max_attempts         INT         NOT NULL DEFAULT 3,
  status               TEXT        NOT NULL DEFAULT 'queued',
  last_error           TEXT,
  next_retry_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_retry_queue_status_next_retry_idx
  ON public.push_retry_queue(status, next_retry_at)
  WHERE status IN ('queued', 'processing');

ALTER TABLE public.push_retry_queue ENABLE ROW LEVEL SECURITY;

-- Service role manages all retry queue operations

-- ── activity_events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.activity_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  category    TEXT        NOT NULL,
  actor_id    UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  source_type TEXT,
  source_id   TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_events_user_created_idx
  ON public.activity_events(user_id, created_at DESC);

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

-- Users read their own activity feed; service role writes
CREATE POLICY "activity_events_select_own"
  ON public.activity_events FOR SELECT
  USING (auth.uid() = user_id);

-- ── Feature flags for the notification system ─────────────────────────────────

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('notifications_enabled',      TRUE,  'Master switch for the in-app notification system'),
  ('push_notifications_enabled', TRUE,  'Enable Expo push delivery via notification_devices table'),
  ('notification_digests_enabled', FALSE, 'Enable daily notification digest batching'),
  ('realtime_activity_enabled',  TRUE,  'Enable SSE realtime activity stream'),
  ('safety_notifications_enabled', TRUE, 'Enable safety-critical notification delivery')
ON CONFLICT (flag) DO NOTHING;
