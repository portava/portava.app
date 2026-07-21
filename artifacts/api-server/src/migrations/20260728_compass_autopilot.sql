-- Phase 13: Trip Autopilot — item lock types, per-trip autopilot permissions,
-- durable change proposals (propose, never auto-execute).

-- 1. Fixed / Flexible / Optional typing on plan items.
--    fixed    — never auto-moved by Autopilot under any circumstances
--    flexible — may be proposed for movement when the user permits it
--    optional — may be proposed for movement or removal when the user permits it
ALTER TABLE trip_plan_items
  ADD COLUMN IF NOT EXISTS lock_type TEXT NOT NULL DEFAULT 'flexible'
  CHECK (lock_type IN ('fixed', 'flexible', 'optional'));

-- 2. User-granted autopilot permissions, per user per trip.
CREATE TABLE IF NOT EXISTS trip_autopilot_settings (
  trip_id              UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  allow_move_flexible  BOOLEAN NOT NULL DEFAULT true,
  allow_move_optional  BOOLEAN NOT NULL DEFAULT true,
  allow_remove_optional BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

-- 3. Autopilot proposals — every suggested change is a durable pending row
--    the user must explicitly confirm; nothing executes automatically.
CREATE TABLE IF NOT EXISTS trip_autopilot_proposals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issue_type  TEXT NOT NULL,
  -- 'timing_conflict' | 'weather_clash' | 'social_change' | 'transport_delay'
  -- | 'closure' | 'item_cancelled' | 'disruption_recovery'
  severity    TEXT NOT NULL DEFAULT 'attention'
              CHECK (severity IN ('watch', 'attention', 'high')),
  reason      TEXT NOT NULL,
  changes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ itemId, title, lockType, before: {...}, after: {...} }]
  dedupe_key  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_autopilot_proposals_trip_status
  ON trip_autopilot_proposals (trip_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_proposals_user
  ON trip_autopilot_proposals (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_proposals_pending_dedupe
  ON trip_autopilot_proposals (trip_id, user_id, dedupe_key)
  WHERE status = 'pending';

ALTER TABLE trip_autopilot_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_autopilot_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_settings_own ON trip_autopilot_settings;
CREATE POLICY autopilot_settings_own ON trip_autopilot_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS autopilot_proposals_own ON trip_autopilot_proposals;
CREATE POLICY autopilot_proposals_own ON trip_autopilot_proposals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
