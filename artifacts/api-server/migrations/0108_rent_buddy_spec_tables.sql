-- Migration 0108: Rent a Buddy — spec table gaps & compatibility aliases
--
-- New functional tables:
--   buddy_services            — typed service catalog (simpler than packages)
--   buddy_availability_exceptions — structured per-date availability overrides
--   buddy_booking_events      — immutable audit log of booking state transitions
--
-- Compatibility VIEW aliases (spec table names → existing rent_buddy_* tables):
--   buddy_booking_checkins    → rent_buddy_safety_checkins
--   buddy_change_requests     → rent_buddy_route_change_requests
--   buddy_favorites           → rent_buddy_saved
--   buddy_booking_requests    → rent_buddy_bookings
--   buddy_profiles            → rent_buddy_profiles
--   buddy_availability        → rent_buddy_availability
--   buddy_reviews             → rent_buddy_reviews
--   buddy_disputes            → rent_buddy_disputes
--
-- VIEW creation is guarded: if a TABLE with the same name already exists
-- (from a future or parallel migration), the CREATE VIEW is skipped gracefully.

-- ── buddy_services ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS buddy_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  hourly_rate_usd NUMERIC(10,2),
  half_day_usd    NUMERIC(10,2),
  full_day_usd    NUMERIC(10,2),
  min_hours       NUMERIC(4,1) NOT NULL DEFAULT 1,
  max_hours       NUMERIC(4,1),
  max_group_size  INT          NOT NULL DEFAULT 4,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  approved        BOOLEAN      NOT NULL DEFAULT FALSE,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY bs_public_read ON buddy_services FOR SELECT
  USING (is_active = TRUE AND approved = TRUE);
CREATE POLICY bs_own_read    ON buddy_services FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bs_own_write   ON buddy_services FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bs_svc         ON buddy_services FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS buddy_services_buddy_idx    ON buddy_services (buddy_id, is_active);
CREATE INDEX IF NOT EXISTS buddy_services_category_idx ON buddy_services (category, is_active);

-- ── buddy_availability_exceptions ──────────────────────────────────────────────

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
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_availability_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bae_public_read ON buddy_availability_exceptions FOR SELECT
  USING (exception_date >= CURRENT_DATE);
CREATE POLICY bae_own_read    ON buddy_availability_exceptions FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bae_own_write   ON buddy_availability_exceptions FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bae_svc         ON buddy_availability_exceptions FOR ALL USING (auth.role() = 'service_role');

-- Unique constraint required by the bulk-upsert endpoint (onConflict: "buddy_id,exception_date")
ALTER TABLE buddy_availability_exceptions
  ADD CONSTRAINT IF NOT EXISTS bae_buddy_date_unique UNIQUE (buddy_id, exception_date);

CREATE INDEX IF NOT EXISTS bae_date_range_idx ON buddy_availability_exceptions (exception_date, end_date);

-- ── buddy_booking_events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS buddy_booking_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES profiles(id),
  event         TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_booking_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY bbe_parties ON buddy_booking_events FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY bbe_svc ON buddy_booking_events FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS bbe_booking_idx    ON buddy_booking_events (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bbe_actor_idx      ON buddy_booking_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bbe_event_type_idx ON buddy_booking_events (event, created_at DESC);

-- ── Compatibility VIEW aliases ─────────────────────────────────────────────────
-- Each VIEW is guarded: if a TABLE with the same name already exists (relkind 'r'
-- for heap table or 'p' for partitioned), the CREATE VIEW is skipped so existing
-- data is not destroyed.  On a fresh DB the VIEW is created normally.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_booking_checkins' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_booking_checkins AS
        SELECT id, booking_id, user_id, checkin_type, response, created_at
        FROM rent_buddy_safety_checkins
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_change_requests' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_change_requests AS
        SELECT id, booking_id, requested_by, old_stops_json, new_stops_json,
               reason, traveler_response, responded_at, created_at
        FROM rent_buddy_route_change_requests
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_favorites' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_favorites AS
        SELECT user_id, buddy_id, notes, created_at
        FROM rent_buddy_saved
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_profiles' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_profiles AS
        SELECT id, user_id, display_name, tagline, bio, intro_video_url, languages,
               city, country, categories, hourly_rate_usd, status, admin_status,
               verified, verified_at, average_rating, review_count, completed_bookings,
               response_time_h, cover_photo_url, gallery_urls, vibe_tags, safety_badges,
               buddy_level, category_approvals,
               new_buddy_public_only, new_buddy_daytime_only, new_buddy_max_hours,
               max_group_size, preferred_meetup_zones, trust_score_override, risk_hold,
               created_at, updated_at
        FROM rent_buddy_profiles
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_availability' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_availability AS
        SELECT id, buddy_id, date, time_slots, is_available, notes, created_at
        FROM rent_buddy_availability
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_reviews' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_reviews AS
        SELECT id, booking_id, reviewer_id, reviewee_id, role, rating,
               safety_score, communication_score, punctuality_score,
               body, is_public, blind_until, photos, created_at, updated_at
        FROM rent_buddy_reviews
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_disputes' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_disputes AS
        SELECT id, booking_id, raised_by, reason, status, resolution_note,
               resolved_at, created_at
        FROM rent_buddy_disputes
    $q$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'buddy_booking_requests' AND c.relkind IN ('r','p') AND n.nspname = 'public'
  ) THEN
    EXECUTE $q$
      CREATE OR REPLACE VIEW buddy_booking_requests AS
        SELECT id, buddy_id, traveler_id, package_id, trip_id, booking_date,
               start_time, duration_h, group_size, city, category, notes,
               payment_mode, total_usd, deposit_usd, cash_balance_usd,
               status, safety_status, confirmed_at, started_at, completed_at,
               cancelled_at, created_at, updated_at
        FROM rent_buddy_bookings
    $q$;
  END IF;
END $$;
