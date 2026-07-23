-- Migration 0175: Daily readiness score snapshots
--
-- Persists one score-per-trip-per-day so the delta indicator in the client can
-- always show "since yesterday" — even after the intra-day items have been
-- recomputed and overwritten.
--
-- The route upserts one row per (trip_id, snapshot_date) on every recompute;
-- the most recent row whose snapshot_date < TODAY is returned as previousScore.
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.

CREATE TABLE IF NOT EXISTS trip_readiness_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  snapshot_date DATE        NOT NULL,
  score         INTEGER     NOT NULL CHECK (score >= 0 AND score <= 100),
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS trs_trip_date_idx ON trip_readiness_snapshots (trip_id, snapshot_date DESC);

ALTER TABLE trip_readiness_snapshots ENABLE ROW LEVEL SECURITY;

-- Members may read their trip's snapshot history (same policy pattern as items).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_readiness_snapshots' AND policyname = 'trs_member_read'
  ) THEN
    CREATE POLICY trs_member_read ON trip_readiness_snapshots FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM trip_members tm
        WHERE tm.trip_id = trip_readiness_snapshots.trip_id
          AND tm.user_id = auth.uid()
          AND tm.role IN ('owner', 'co_host', 'member', 'viewer')
          AND (tm.status IS NULL OR tm.status = 'accepted')
      )
      OR EXISTS (
        SELECT 1 FROM trips t
        WHERE t.id = trip_readiness_snapshots.trip_id
          AND t.owner_id = auth.uid()
      )
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_readiness_snapshots' AND policyname = 'trs_svc'
  ) THEN
    CREATE POLICY trs_svc ON trip_readiness_snapshots FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
