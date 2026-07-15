-- =============================================================================
-- 0077_trips_expansion.sql
-- Expand trips table: new columns + status enum additions (draft, archived)
-- All new columns have safe defaults so existing rows are unaffected.
-- =============================================================================

-- Add draft and archived to the trip_status enum
DO $$ BEGIN
  ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'draft'    BEFORE 'planning';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'archived' AFTER  'cancelled';
EXCEPTION WHEN others THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- trips: new columns
-- ---------------------------------------------------------------------------
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS trip_type                TEXT         DEFAULT 'leisure',
  ADD COLUMN IF NOT EXISTS timezone                 TEXT,
  ADD COLUMN IF NOT EXISTS destination_lat          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS destination_lng          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS destination_place_id     TEXT,
  ADD COLUMN IF NOT EXISTS trip_notes               TEXT,
  -- privacy / discoverability block
  ADD COLUMN IF NOT EXISTS show_on_profile          BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_in_discovery        BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_friend_suggestions BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_trip_crew_invites  BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_join_requests      BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_exact_dates         BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_destination_city    BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS delayed_posting_default  BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS precise_location_visible BOOLEAN      NOT NULL DEFAULT false;
