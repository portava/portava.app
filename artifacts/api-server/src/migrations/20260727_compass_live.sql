-- Phase 12: Compass Live — persisted per-user live travel sessions.
--
-- A live session is explicitly started and stopped by the user. While active
-- it holds rolling context (current stop, next plan item, recent events) as
-- JSONB; on stop it stores an end-of-session summary. One active session per
-- user is enforced with a partial unique index.
--
-- Privacy: context is city-level / plan-item-level only — no coordinates are
-- ever stored here (mirrors the CompassLocationContext guarantees).

CREATE TABLE IF NOT EXISTS compass_live_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trip_id          UUID,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  context          JSONB NOT NULL DEFAULT '{}'::jsonb,
  checks_run       INTEGER NOT NULL DEFAULT 0,
  nudges_delivered INTEGER NOT NULL DEFAULT 0,
  summary          JSONB,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_check_at    TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_live_sessions_one_active
  ON compass_live_sessions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_live_sessions_user_started
  ON compass_live_sessions (user_id, started_at DESC);

ALTER TABLE compass_live_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_sessions_own ON compass_live_sessions;
CREATE POLICY live_sessions_own ON compass_live_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
