-- 0133_rent_buddy_availability_alignment.sql
--
-- Aligns the live availability schema with what the API server code expects,
-- so buddy vacation/blocked dates actually persist and block bookings.
--
-- 1. The live rent_buddy_availability table predates 0047_rent_buddy.sql and
--    kept a legacy shape (buddy_id, city, date_from, date_to, is_blocked, note),
--    so 0047's CREATE TABLE IF NOT EXISTS silently no-oped. The table is empty
--    in every environment (verified 2026-07-15), so it is safe to recreate it
--    in the per-date-slots shape the dashboard routes use.
-- 2. Creates buddy_availability_exceptions (from unapplied 0108_rent_buddy_spec_tables.sql,
--    minus its invalid `ADD CONSTRAINT IF NOT EXISTS` statement) — the table the
--    booking-creation route consults to reject bookings on blocked/vacation dates.
-- 3. Adds availability-settings columns to rent_buddy_profiles used by the
--    availability screen (available_now, min notice, buffer, max bookings/day).

-- ── 1. rent_buddy_availability → per-date slots shape ─────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'rent_buddy_availability'
      AND column_name = 'date_from'
  ) THEN
    IF (SELECT COUNT(*) FROM rent_buddy_availability) > 0 THEN
      RAISE EXCEPTION 'legacy rent_buddy_availability is not empty — manual migration required';
    END IF;
    DROP TABLE rent_buddy_availability;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rent_buddy_availability (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id      UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  time_slots    TEXT[] NOT NULL DEFAULT '{}',
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (buddy_id, date)
);

ALTER TABLE rent_buddy_availability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rb_avail_read ON rent_buddy_availability;
CREATE POLICY rb_avail_read ON rent_buddy_availability FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS rb_avail_own ON rent_buddy_availability;
CREATE POLICY rb_avail_own  ON rent_buddy_availability FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS rb_avail_svc ON rent_buddy_availability;
CREATE POLICY rb_avail_svc  ON rent_buddy_availability FOR ALL USING (auth.role() = 'service_role');

-- ── 2. buddy_availability_exceptions ──────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE buddy_exception_type AS ENUM (
    'blocked',
    'time_blocked',
    'vacation',
    'available_only'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS buddy_availability_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  exception_date  DATE NOT NULL,
  end_date        DATE,
  exception_type  buddy_exception_type NOT NULL DEFAULT 'blocked',
  start_time      TIME,
  end_time        TIME,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bae_buddy_date_unique UNIQUE (buddy_id, exception_date)
);

ALTER TABLE buddy_availability_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bae_public_read ON buddy_availability_exceptions;
CREATE POLICY bae_public_read ON buddy_availability_exceptions FOR SELECT
  USING (exception_date >= CURRENT_DATE);
DROP POLICY IF EXISTS bae_own_read ON buddy_availability_exceptions;
CREATE POLICY bae_own_read    ON buddy_availability_exceptions FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS bae_own_write ON buddy_availability_exceptions;
CREATE POLICY bae_own_write   ON buddy_availability_exceptions FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS bae_svc ON buddy_availability_exceptions;
CREATE POLICY bae_svc         ON buddy_availability_exceptions FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS bae_date_range_idx ON buddy_availability_exceptions (exception_date, end_date);

-- ── 3. Availability settings columns on rent_buddy_profiles ───────────────────

ALTER TABLE rent_buddy_profiles ADD COLUMN IF NOT EXISTS available_now        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rent_buddy_profiles ADD COLUMN IF NOT EXISTS available_now_until  TIMESTAMPTZ;
ALTER TABLE rent_buddy_profiles ADD COLUMN IF NOT EXISTS min_notice_hours     INTEGER;
ALTER TABLE rent_buddy_profiles ADD COLUMN IF NOT EXISTS buffer_minutes       INTEGER;
ALTER TABLE rent_buddy_profiles ADD COLUMN IF NOT EXISTS max_bookings_per_day INTEGER;
