-- Migration 0033: location_sessions, location_snapshots, location_trust_events
-- Safe to re-run: IF NOT EXISTS throughout

-- Active location-share sessions (Safe Return / trusted-circle live share)
CREATE TABLE IF NOT EXISTS location_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- private_stay | safe_return | trusted_circle | plan_checkin
  session_type      TEXT        NOT NULL DEFAULT 'safe_return',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  -- approximate location — no exact GPS exposed
  city              TEXT,
  district          TEXT,
  country           TEXT,
  country_code      TEXT,
  -- exact coords stored server-side only, never returned in public APIs
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  -- linked plan or trip
  related_trip_id   UUID,
  related_plan_id   UUID,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ls_user_idx       ON location_sessions (user_id);
CREATE INDEX IF NOT EXISTS ls_expires_idx    ON location_sessions (expires_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ls_session_type   ON location_sessions (session_type);

ALTER TABLE location_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='location_sessions' AND policyname='lsess_own') THEN
    CREATE POLICY lsess_own ON location_sessions USING (auth.uid() = user_id);
  END IF;
END $$;

-- Short-TTL coordinate snapshots (max retention: 24h, cleaned by job)
-- Never returned in public-facing APIs; used only for proximity checks
CREATE TABLE IF NOT EXISTS location_snapshots (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  accuracy_meters DOUBLE PRECISION,
  source          TEXT        NOT NULL DEFAULT 'gps',
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS lsnap_user_idx    ON location_snapshots (user_id);
CREATE INDEX IF NOT EXISTS lsnap_expires_idx ON location_snapshots (expires_at);

ALTER TABLE location_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='location_snapshots' AND policyname='lsnap_own') THEN
    CREATE POLICY lsnap_own ON location_snapshots USING (auth.uid() = user_id);
  END IF;
END $$;

-- Anti-fake GPS audit log (no auto-ban, review only)
CREATE TABLE IF NOT EXISTS location_trust_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- impossible_speed | coordinate_jump | ip_city_mismatch | manual_review | cleared
  event_type      TEXT        NOT NULL,
  confidence      TEXT        NOT NULL DEFAULT 'low',  -- low | medium | high
  details         JSONB,
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lte_user_idx      ON location_trust_events (user_id);
CREATE INDEX IF NOT EXISTS lte_created_idx   ON location_trust_events (created_at);
CREATE INDEX IF NOT EXISTS lte_reviewed_idx  ON location_trust_events (reviewed_at) WHERE reviewed_at IS NULL;

ALTER TABLE location_trust_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- Users can read their own trust events; service role writes them
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='location_trust_events' AND policyname='lte_select_own') THEN
    CREATE POLICY lte_select_own ON location_trust_events FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;
