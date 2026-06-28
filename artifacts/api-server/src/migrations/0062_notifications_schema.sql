-- Migration 0062: Full notifications schema
--
-- Creates all tables required by the push notification pipeline.
-- Safe to re-run: CREATE TABLE/INDEX use IF NOT EXISTS; policies are
-- wrapped in DO $$ blocks that skip creation when the policy already exists.
-- Feature-flag inserts use ON CONFLICT DO NOTHING.
-- Does NOT drop data, disable RLS, or weaken any policy.
--
-- Tables created:
--   public.notifications               — in-app Activity Centre rows
--   public.notification_devices        — per-device Expo push tokens
--   public.notification_preferences    — per-user global delivery toggles
--   public.notification_category_preferences — per-category overrides
--   public.notification_delivery_attempts   — audit log of every dispatch
--   public.push_retry_queue            — transient-failure retry queue
--   public.activity_events             — raw activity event log
--
-- All tables use service-role writes and per-user RLS reads (see policies
-- below).  Service-role-only tables (notification_delivery_attempts,
-- push_retry_queue) have RLS enabled but no user-facing SELECT policies.

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notifications'
      AND policyname = 'notifications_select_own'
  ) THEN
    CREATE POLICY "notifications_select_own"
      ON public.notifications FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_devices ──────────────────────────────────────────────────────
-- Service-role manages all writes; users can read their own device rows.

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_devices'
      AND policyname = 'notification_devices_select_own'
  ) THEN
    CREATE POLICY "notification_devices_select_own"
      ON public.notification_devices FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_preferences ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id             UUID        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  email_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  in_app_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  digests_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  safety_override     BOOLEAN     NOT NULL DEFAULT TRUE,
  quiet_hours_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  quiet_start         TEXT        NOT NULL DEFAULT '22:00',
  quiet_end           TEXT        NOT NULL DEFAULT '08:00',
  message_previews    BOOLEAN     NOT NULL DEFAULT TRUE,
  location_previews   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_preferences'
      AND policyname = 'notification_prefs_select_own'
  ) THEN
    CREATE POLICY "notification_prefs_select_own"
      ON public.notification_preferences FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_preferences'
      AND policyname = 'notification_prefs_insert_own'
  ) THEN
    CREATE POLICY "notification_prefs_insert_own"
      ON public.notification_preferences FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_preferences'
      AND policyname = 'notification_prefs_update_own'
  ) THEN
    CREATE POLICY "notification_prefs_update_own"
      ON public.notification_preferences FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_category_preferences'
      AND policyname = 'notification_cat_prefs_select_own'
  ) THEN
    CREATE POLICY "notification_cat_prefs_select_own"
      ON public.notification_category_preferences FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_category_preferences'
      AND policyname = 'notification_cat_prefs_insert_own'
  ) THEN
    CREATE POLICY "notification_cat_prefs_insert_own"
      ON public.notification_category_preferences FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification_category_preferences'
      AND policyname = 'notification_cat_prefs_update_own'
  ) THEN
    CREATE POLICY "notification_cat_prefs_update_own"
      ON public.notification_category_preferences FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_delivery_attempts ───────────────────────────────────────────
-- Service-role only: audit log of every dispatch attempt.
-- RLS is enabled but no user-facing SELECT policy is intentional —
-- raw delivery internals are not exposed to end users.

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

-- ── push_retry_queue ──────────────────────────────────────────────────────────
-- Service-role only: the retry worker runs with the service role client.
-- user_id references public.profiles(id) — consistent with all other
-- notification tables and with how the app code resolves user identity
-- (supabase.auth.getUser() returns the same UUID as profiles.id).
-- RLS is enabled but no user-facing SELECT policy is intentional.

CREATE TABLE IF NOT EXISTS public.push_retry_queue (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id      UUID        REFERENCES public.notifications(id) ON DELETE SET NULL,
  delivery_attempt_id  UUID        REFERENCES public.notification_delivery_attempts(id) ON DELETE SET NULL,
  user_id              UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tokens               TEXT[]      NOT NULL DEFAULT '{}',
  payload              JSONB       NOT NULL DEFAULT '{}',
  attempt_count        INT         NOT NULL DEFAULT 1,
  max_attempts         INT         NOT NULL DEFAULT 3,
  status               TEXT        NOT NULL DEFAULT 'queued'
                                   CHECK (status IN ('queued','processing','sent','failed')),
  last_error           TEXT,
  next_retry_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_retry_queue_status_next_retry_idx
  ON public.push_retry_queue(status, next_retry_at)
  WHERE status IN ('queued', 'processing');

ALTER TABLE public.push_retry_queue ENABLE ROW LEVEL SECURITY;

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_events'
      AND policyname = 'activity_events_select_own'
  ) THEN
    CREATE POLICY "activity_events_select_own"
      ON public.activity_events FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Feature flags ─────────────────────────────────────────────────────────────
-- Guard: only insert if the feature_flags table actually exists in this DB.
-- ON CONFLICT DO NOTHING means re-running never overwrites existing flag states.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'feature_flags'
  ) THEN
    INSERT INTO public.feature_flags (flag, enabled, description) VALUES
      ('notifications_enabled',        TRUE,  'Master switch for the in-app notification system'),
      ('push_notifications_enabled',   TRUE,  'Enable Expo push delivery via notification_devices table'),
      ('notification_digests_enabled', FALSE, 'Enable daily notification digest batching'),
      ('realtime_activity_enabled',    TRUE,  'Enable SSE realtime activity stream'),
      ('safety_notifications_enabled', TRUE,  'Enable safety-critical notification delivery')
    ON CONFLICT (flag) DO NOTHING;
  END IF;
END $$;
