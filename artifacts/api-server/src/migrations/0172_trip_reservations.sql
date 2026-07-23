-- Migration 0172: trip reservations (paste-to-import + manual)
--
-- Stores flight / stay / activity / transport bookings attached to a trip.
-- Pasted-text imports are LLM-extracted server-side and land here with
-- status 'pending_confirm' — extraction NEVER auto-commits to the trip plan.
-- Only an explicit /confirm (optionally with addToPlan) touches trip_plan_items.
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.

CREATE TABLE IF NOT EXISTS trip_reservations (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                  UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type                     TEXT        NOT NULL
    CHECK (type IN ('flight', 'stay', 'activity', 'transport', 'other')),
  title                    TEXT        NOT NULL CHECK (char_length(title) <= 300),
  starts_at                TIMESTAMPTZ NULL,
  ends_at                  TIMESTAMPTZ NULL,
  location_name            TEXT        NULL,
  confirmation_ref         TEXT        NULL,
  cancellation_deadline_at TIMESTAMPTZ NULL,
  raw_text                 TEXT        NULL,     -- original pasted text (audit / re-extract)
  extraction               JSONB       NULL,     -- model output for this row, verbatim
  extraction_confidence    NUMERIC     NULL,     -- model-reported 0..1 (never invented)
  status                   TEXT        NOT NULL DEFAULT 'pending_confirm'
    CHECK (status IN ('pending_confirm', 'confirmed', 'dismissed')),
  created_from             TEXT        NOT NULL DEFAULT 'manual'
    CHECK (created_from IN ('paste', 'manual')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_reservations_trip_idx
  ON trip_reservations (trip_id);
CREATE INDEX IF NOT EXISTS trip_reservations_cancel_deadline_idx
  ON trip_reservations (trip_id, cancellation_deadline_at);

ALTER TABLE trip_reservations ENABLE ROW LEVEL SECURITY;

-- Any accepted trip member (or the trip owner) may read reservations.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_reservations' AND policyname = 'trip_reservations_member_read'
  ) THEN
    CREATE POLICY trip_reservations_member_read ON trip_reservations FOR SELECT
      USING (
        EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
        OR EXISTS (
          SELECT 1 FROM trip_members m
          WHERE m.trip_id = trip_reservations.trip_id
            AND m.user_id = auth.uid()
            AND m.role IN ('owner', 'co_host', 'member', 'viewer')
        )
      );
  END IF;
END $$;

-- Latent owner-write policies: the API writes via the service role today, but
-- these keep direct PostgREST access safe if it is ever enabled.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_reservations' AND policyname = 'trip_reservations_owner_insert'
  ) THEN
    CREATE POLICY trip_reservations_owner_insert ON trip_reservations FOR INSERT
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_reservations' AND policyname = 'trip_reservations_owner_update'
  ) THEN
    CREATE POLICY trip_reservations_owner_update ON trip_reservations FOR UPDATE
      USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_reservations' AND policyname = 'trip_reservations_owner_delete'
  ) THEN
    CREATE POLICY trip_reservations_owner_delete ON trip_reservations FOR DELETE
      USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
      );
  END IF;
END $$;

-- Service role bypasses the above for the API's explicit permission checks.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_reservations' AND policyname = 'trip_reservations_svc'
  ) THEN
    CREATE POLICY trip_reservations_svc ON trip_reservations
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flags ─────────────────────────────────────────────────────────────
-- NOTE: feature_flags PK column is `flag` (0037), never `key`.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('reservation_import_enabled', false, 'Paste-to-import reservations with confirm-before-commit'),
  ('nl_trip_creation_enabled',   false, 'Natural-language trip draft extraction')
ON CONFLICT (flag) DO NOTHING;
