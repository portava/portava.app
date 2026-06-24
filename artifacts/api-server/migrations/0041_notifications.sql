-- Migration 0041: notifications — Unified Notification & Activity Center
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout

-- ── notification_devices ──────────────────────────────────────────────────────
-- One row per registered Expo push token (replaces single expo_push_token col).

CREATE TABLE IF NOT EXISTS notification_devices (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  push_token  TEXT        NOT NULL,
  platform    TEXT        NOT NULL DEFAULT 'expo'
    CHECK (platform IN ('expo', 'apns', 'fcm')),
  label       TEXT,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);

CREATE INDEX IF NOT EXISTS nd_user_idx ON notification_devices (user_id);

ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notification_devices' AND policyname='nd_own') THEN
    CREATE POLICY nd_own ON notification_devices USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notifications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL
    CHECK (category IN ('plans','trips','telegraph','safe_return','location','trip_crew',
                        'compass','pulse','passport','hidden_gems','trust','airport','admin')),
  event_type    TEXT        NOT NULL,
  priority      TEXT        NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent','important','normal','low')),
  title         TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  action_url    TEXT,
  image_url     TEXT,
  source_type   TEXT,
  source_id     TEXT,
  actor_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  privacy_level TEXT        NOT NULL DEFAULT 'standard'
    CHECK (privacy_level IN ('standard','sensitive','ghost_hidden')),
  read_at       TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notif_user_idx      ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_unread_idx    ON notifications (user_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS notif_category_idx  ON notifications (user_id, category);
CREATE INDEX IF NOT EXISTS notif_expires_idx   ON notifications (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS notif_dedup_idx     ON notifications (user_id, category, source_type, source_id, created_at DESC)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notifications' AND policyname='notif_own') THEN
    CREATE POLICY notif_own ON notifications USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_preferences ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id               UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  push_enabled          BOOLEAN     NOT NULL DEFAULT true,
  email_enabled         BOOLEAN     NOT NULL DEFAULT false,
  in_app_enabled        BOOLEAN     NOT NULL DEFAULT true,
  digests_enabled       BOOLEAN     NOT NULL DEFAULT false,
  safety_override       BOOLEAN     NOT NULL DEFAULT true,
  quiet_hours_enabled   BOOLEAN     NOT NULL DEFAULT false,
  quiet_start           TEXT        NOT NULL DEFAULT '22:00',
  quiet_end             TEXT        NOT NULL DEFAULT '08:00',
  message_previews      BOOLEAN     NOT NULL DEFAULT true,
  location_previews     BOOLEAN     NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notification_preferences' AND policyname='np_own') THEN
    CREATE POLICY np_own ON notification_preferences USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_category_preferences ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_category_preferences (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category        TEXT        NOT NULL
    CHECK (category IN ('plans','trips','telegraph','safe_return','location','trip_crew',
                        'compass','pulse','passport','hidden_gems','trust','airport','admin')),
  in_app_enabled  BOOLEAN     NOT NULL DEFAULT true,
  push_enabled    BOOLEAN     NOT NULL DEFAULT true,
  email_enabled   BOOLEAN     NOT NULL DEFAULT false,
  digest_enabled  BOOLEAN     NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);

CREATE INDEX IF NOT EXISTS ncp_user_idx ON notification_category_preferences (user_id);

ALTER TABLE notification_category_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notification_category_preferences' AND policyname='ncp_own') THEN
    CREATE POLICY ncp_own ON notification_category_preferences USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_delivery_attempts ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel         TEXT        NOT NULL CHECK (channel IN ('in_app','push','email','sms','telegraph')),
  status          TEXT        NOT NULL CHECK (status IN ('pending','sent','delivered','failed','suppressed')),
  error_message   TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nda_notif_idx ON notification_delivery_attempts (notification_id);
CREATE INDEX IF NOT EXISTS nda_user_idx  ON notification_delivery_attempts (user_id, created_at DESC);

ALTER TABLE notification_delivery_attempts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='notification_delivery_attempts' AND policyname='nda_own_read') THEN
    CREATE POLICY nda_own_read ON notification_delivery_attempts FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── activity_events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  actor_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  source_type   TEXT,
  source_id     TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ae_user_idx     ON activity_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ae_category_idx ON activity_events (user_id, category);

ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='activity_events' AND policyname='ae_own') THEN
    CREATE POLICY ae_own ON activity_events USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Feature flags for notifications ──────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description, updated_at)
VALUES
  ('notifications_enabled',        true,  'Master switch for the notification system',                    now()),
  ('activity_center_enabled',      true,  'Enables the Activity Center screen in the mobile app',         now()),
  ('push_notifications_enabled',   true,  'Enables push notification delivery via Expo',                  now()),
  ('notification_digests_enabled', false, 'Enables daily digest emails (requires email provider setup)',  now()),
  ('realtime_activity_enabled',    true,  'Broadcasts notification events over the SSE realtime bus',     now()),
  ('safety_notifications_enabled', true,  'Enables safety-priority notifications (safe return, trust)',   now())
ON CONFLICT (flag) DO NOTHING;
