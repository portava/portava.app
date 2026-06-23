-- Migration 0040: safe_return — full Safe Return system
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout

-- ── safe_return_sessions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safe_return_sessions (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_item_id             UUID,                 -- optional link to a trip plan item
  trip_id                  UUID,                 -- optional link to a trip
  status                   TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'safe', 'missed', 'cancelled')),
  trigger_reason           TEXT,                 -- why Safe Return was suggested
  escalation_level         SMALLINT    NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3),
  timer_start_at           TIMESTAMPTZ,
  timer_end_at             TIMESTAMPTZ,
  last_prompt_at           TIMESTAMPTZ,          -- last time user was reminded
  last_safe_confirmation_at TIMESTAMPTZ,
  trusted_circle_enabled   BOOLEAN     NOT NULL DEFAULT false,
  live_share_enabled       BOOLEAN     NOT NULL DEFAULT false,
  notify_host_enabled      BOOLEAN     NOT NULL DEFAULT false,
  notify_trip_crew_enabled BOOLEAN     NOT NULL DEFAULT false,
  emergency_note           TEXT,
  closed_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS srs_user_idx      ON safe_return_sessions (user_id);
CREATE INDEX IF NOT EXISTS srs_status_idx    ON safe_return_sessions (status) WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS srs_trip_idx      ON safe_return_sessions (trip_id) WHERE trip_id IS NOT NULL;

ALTER TABLE safe_return_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='safe_return_sessions' AND policyname='srs_own') THEN
    CREATE POLICY srs_own ON safe_return_sessions USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── safe_return_contacts ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safe_return_contacts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID        NOT NULL REFERENCES safe_return_sessions(id) ON DELETE CASCADE,
  contact_user_id         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_name            TEXT,
  contact_phone           TEXT,
  contact_email           TEXT,
  contact_method          TEXT        NOT NULL DEFAULT 'in_app'
    CHECK (contact_method IN ('in_app', 'sms', 'email')),
  can_receive_live_location BOOLEAN   NOT NULL DEFAULT false,
  notified_at             TIMESTAMPTZ,
  acknowledged_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS src_session_idx       ON safe_return_contacts (session_id);
CREATE INDEX IF NOT EXISTS src_contact_user_idx  ON safe_return_contacts (contact_user_id) WHERE contact_user_id IS NOT NULL;

ALTER TABLE safe_return_contacts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='safe_return_contacts' AND policyname='src_session_owner') THEN
    -- Session owner can read their own contacts; contact_user_id can also read their own row
    CREATE POLICY src_session_owner ON safe_return_contacts FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM safe_return_sessions s
        WHERE s.id = session_id AND s.user_id = auth.uid()
      )
      OR contact_user_id = auth.uid()
    );
  END IF;
END $$;

-- ── safe_return_events ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safe_return_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL REFERENCES safe_return_sessions(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL,
  -- Valid event_type values (not CHECK-constrained so new values don't need DDL):
  --   session_created | session_started | timer_extended | safe_confirmed
  --   session_cancelled | check_in_missed | trusted_circle_notified
  --   host_notified | crew_notified | live_share_started | live_share_stopped
  --   live_share_expired | escalation_level_changed
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sre_session_idx  ON safe_return_events (session_id);
CREATE INDEX IF NOT EXISTS sre_user_idx     ON safe_return_events (user_id);
CREATE INDEX IF NOT EXISTS sre_created_idx  ON safe_return_events (created_at);

ALTER TABLE safe_return_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='safe_return_events' AND policyname='sre_session_owner') THEN
    CREATE POLICY sre_session_owner ON safe_return_events FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM safe_return_sessions s
        WHERE s.id = session_id AND s.user_id = auth.uid()
      )
    );
  END IF;
END $$;

-- ── safe_return_live_shares ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safe_return_live_shares (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             UUID        NOT NULL REFERENCES safe_return_sessions(id) ON DELETE CASCADE,
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_user_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_contact_id   UUID        REFERENCES safe_return_contacts(id) ON DELETE SET NULL,
  status                 TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stopped', 'expired')),
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ,
  stopped_at             TIMESTAMPTZ,
  last_location_snapshot_id UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS srls_session_idx    ON safe_return_live_shares (session_id);
CREATE INDEX IF NOT EXISTS srls_recipient_idx  ON safe_return_live_shares (recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS srls_expires_idx    ON safe_return_live_shares (expires_at) WHERE status = 'active';

ALTER TABLE safe_return_live_shares ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='safe_return_live_shares' AND policyname='srls_owner') THEN
    CREATE POLICY srls_owner ON safe_return_live_shares FOR SELECT USING (
      user_id = auth.uid() OR recipient_user_id = auth.uid()
    );
  END IF;
END $$;

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('safe_return_enabled',                    FALSE, 'Safe Return: master switch — timed check-ins and escalation'),
  ('safe_return_live_share_enabled',         FALSE, 'Safe Return: opt-in temporary live location sharing'),
  ('safe_return_trusted_circle_alerts_enabled', FALSE, 'Safe Return: opt-in Trusted Circle notifications'),
  ('safe_return_admin_logs_enabled',         TRUE,  'Safe Return: admin event log and config endpoints')
ON CONFLICT (key) DO NOTHING;
