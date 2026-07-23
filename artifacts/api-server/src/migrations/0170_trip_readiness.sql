-- Migration 0170: Trip Readiness engine
--
-- Persisted, recomputable readiness items per trip. Each row is one derived
-- finding ("No accommodation planned", "Visa/authorization required", ...)
-- keyed by a stable dedupe_key so recomputes upsert in place and stale rows
-- can be swept. user_id is NULL for trip-wide items and set for member-scoped
-- items (e.g. per-traveler entry requirements).
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.

-- ── trip_readiness_items ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trip_readiness_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  -- NULL = trip-wide item; set = member-scoped item (e.g. entry requirements)
  category    TEXT        NOT NULL
    CHECK (category IN ('plan', 'stay', 'transport', 'budget', 'entry', 'documents', 'reservations')),
  status      TEXT        NOT NULL
    CHECK (status IN ('ready', 'action_needed', 'incomplete', 'unknown')),
  severity    TEXT        NOT NULL DEFAULT 'normal'
    CHECK (severity IN ('normal', 'critical')),
  title       TEXT        NOT NULL,
  detail      TEXT,
  due_at      TIMESTAMPTZ,
  action_ref  JSONB,
  dedupe_key  TEXT        NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS tri_trip_idx          ON trip_readiness_items (trip_id);
CREATE INDEX IF NOT EXISTS tri_trip_severity_idx ON trip_readiness_items (trip_id, severity);

ALTER TABLE trip_readiness_items ENABLE ROW LEVEL SECURITY;

-- Member-read latent policy: any accepted trip member (or the trip owner) may
-- read the trip's readiness items. Writes go through the service role only —
-- the engine is the single writer.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_readiness_items' AND policyname = 'tri_member_read'
  ) THEN
    CREATE POLICY tri_member_read ON trip_readiness_items FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM trip_members tm
        WHERE tm.trip_id = trip_readiness_items.trip_id
          AND tm.user_id = auth.uid()
          AND tm.role IN ('owner', 'co_host', 'member', 'viewer')
          AND (tm.status IS NULL OR tm.status = 'accepted')
      )
      OR EXISTS (
        SELECT 1 FROM trips t
        WHERE t.id = trip_readiness_items.trip_id
          AND t.owner_id = auth.uid()
      )
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_readiness_items' AND policyname = 'tri_svc'
  ) THEN
    CREATE POLICY tri_svc ON trip_readiness_items FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flag ──────────────────────────────────────────────────────────────
-- NOTE: the feature_flags PK column is `flag` (0037_feature_flags.sql).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('trip_readiness_enabled', false, 'Trip readiness engine + next best action')
ON CONFLICT (flag) DO NOTHING;
