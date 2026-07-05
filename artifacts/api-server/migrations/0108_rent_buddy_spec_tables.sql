-- Migration 0108: Rent a Buddy — spec table gaps & compatibility aliases
--
-- New functional tables (fill gaps the routes need for downstream tasks):
--   buddy_services            — typed service catalog (simpler than packages)
--   buddy_availability_exceptions — structured per-date availability overrides
--   buddy_booking_events      — immutable audit log of booking state transitions
--
-- Compatibility VIEW aliases (spec table names → existing rent_buddy_* tables):
--   buddy_booking_checkins    → rent_buddy_safety_checkins
--   buddy_change_requests     → rent_buddy_route_change_requests
--   buddy_favorites           → rent_buddy_saved
--   buddy_booking_requests    → rent_buddy_bookings
--
-- All CREATE TABLE / CREATE VIEW statements are idempotent.

-- ── buddy_services ─────────────────────────────────────────────────────────────
-- A typed catalog of services a buddy offers (category + rate).
-- Conceptually simpler than rent_buddy_packages (no itinerary stops).
-- One buddy can offer many services; one service ≈ one bookable category.

CREATE TABLE IF NOT EXISTS buddy_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,  -- e.g. 'city','language','nightlife','arrival','content'
  title           TEXT NOT NULL,
  description     TEXT,
  hourly_rate_usd NUMERIC(10,2),
  half_day_usd    NUMERIC(10,2),
  full_day_usd    NUMERIC(10,2),
  min_hours       NUMERIC(4,1)  NOT NULL DEFAULT 1,
  max_hours       NUMERIC(4,1),
  max_group_size  INT           NOT NULL DEFAULT 4,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  approved        BOOLEAN       NOT NULL DEFAULT FALSE,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY bs_read ON buddy_services FOR SELECT USING (TRUE);
CREATE POLICY bs_own  ON buddy_services FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bs_svc  ON buddy_services FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS buddy_services_buddy_idx    ON buddy_services (buddy_id, is_active);
CREATE INDEX IF NOT EXISTS buddy_services_category_idx ON buddy_services (category, is_active);

-- ── buddy_availability_exceptions ──────────────────────────────────────────────
-- Structured per-date availability overrides.
-- Supplements the JSONB one_time_blocks / vacation_dates columns in
-- rent_buddy_availability with a queryable row-per-exception model.

DO $$ BEGIN
  CREATE TYPE buddy_exception_type AS ENUM (
    'blocked',       -- buddy unavailable all day
    'time_blocked',  -- specific time window blocked
    'vacation',      -- multi-day vacation block
    'available_only' -- override: available ONLY during these hours
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS buddy_availability_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  exception_date  DATE NOT NULL,
  end_date        DATE,           -- NULL = single day; set for vacation ranges
  exception_type  buddy_exception_type NOT NULL DEFAULT 'blocked',
  start_time      TIME,           -- for time_blocked / available_only
  end_time        TIME,           -- for time_blocked / available_only
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_availability_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bae_read ON buddy_availability_exceptions FOR SELECT USING (TRUE);
CREATE POLICY bae_own  ON buddy_availability_exceptions FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bae_svc  ON buddy_availability_exceptions FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS bae_buddy_date_idx ON buddy_availability_exceptions (buddy_id, exception_date);
CREATE INDEX IF NOT EXISTS bae_date_range_idx ON buddy_availability_exceptions (exception_date, end_date);

-- ── buddy_booking_events ───────────────────────────────────────────────────────
-- Immutable audit log of all booking state transitions.
-- Written by route handlers when booking status changes.
-- Enables: audit trail, transition enforcement (query last known status),
--          and analytics (time-in-state per booking).

CREATE TABLE IF NOT EXISTS buddy_booking_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES profiles(id),
  event         TEXT NOT NULL,  -- 'accepted','declined','started','completed','cancelled','dispute_opened',...
  from_status   TEXT,           -- previous rent_buddy_booking_status value
  to_status     TEXT,           -- new rent_buddy_booking_status value
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_booking_events ENABLE ROW LEVEL SECURITY;

-- Parties to the booking can read their own events; service role reads all
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
-- Spec-named views that proxy to the production rent_buddy_* tables.
-- Provides stable spec-contract names for mobile clients and downstream tasks.

CREATE OR REPLACE VIEW buddy_booking_checkins AS
  SELECT
    id,
    booking_id,
    user_id,
    checkin_type   AS checkin_type,
    response,
    created_at
  FROM rent_buddy_safety_checkins;

CREATE OR REPLACE VIEW buddy_change_requests AS
  SELECT
    id,
    booking_id,
    requested_by,
    old_stops_json,
    new_stops_json,
    reason,
    traveler_response,
    responded_at,
    created_at
  FROM rent_buddy_route_change_requests;

CREATE OR REPLACE VIEW buddy_favorites AS
  SELECT
    user_id,
    buddy_id,
    notes,
    created_at
  FROM rent_buddy_saved;

-- Spec-name VIEW aliases for the three core tables so client code that uses
-- the un-prefixed names resolves without changes.

CREATE OR REPLACE VIEW buddy_profiles AS
  SELECT
    id, user_id, display_name, tagline, bio, intro_video_url, languages,
    city, country, categories, hourly_rate_usd, status, admin_status,
    verified, verified_at, average_rating, review_count, completed_bookings,
    response_time_h, cover_photo_url, gallery_urls, vibe_tags, safety_badges,
    buddy_level, category_approvals,
    new_buddy_public_only, new_buddy_daytime_only, new_buddy_max_hours,
    max_group_size, preferred_meetup_zones, trust_score_override, risk_hold,
    created_at, updated_at
  FROM rent_buddy_profiles;

CREATE OR REPLACE VIEW buddy_availability AS
  SELECT id, buddy_id, date, time_slots, is_available, notes, created_at
  FROM rent_buddy_availability;

CREATE OR REPLACE VIEW buddy_reviews AS
  SELECT
    id, booking_id, reviewer_id, reviewee_id, role, rating,
    safety_score, communication_score, punctuality_score,
    body, is_public, blind_until, photos, created_at, updated_at
  FROM rent_buddy_reviews;

-- buddy_disputes: spec-named view proxying rent_buddy_disputes
CREATE OR REPLACE VIEW buddy_disputes AS
  SELECT
    id,
    booking_id,
    raised_by,
    reason,
    details,
    status,
    resolved_at,
    resolution_notes,
    created_at
  FROM rent_buddy_disputes;

CREATE OR REPLACE VIEW buddy_booking_requests AS
  SELECT
    id,
    buddy_id,
    traveler_id,
    package_id,
    trip_id,
    booking_date,
    start_time,
    duration_h,
    group_size,
    city,
    category,
    notes,
    payment_mode,
    total_usd,
    deposit_usd,
    cash_balance_usd,
    status,
    safety_status,
    confirmed_at,
    started_at,
    completed_at,
    cancelled_at,
    created_at,
    updated_at
  FROM rent_buddy_bookings;
