-- Migration 0047: rent_buddy
-- Full Rent-a-Buddy feature schema: profiles, applications, availability,
-- packages, addons, saved, waitlist, bookings, booking_extensions,
-- route_stops, route_change_requests, safety_checkins, safety_events,
-- user_limits, emergency_contacts_snapshot, reviews, disputes,
-- policy_flags, admin_actions.
-- Seeds rent_buddy_enabled feature flag.

-- ── rent_buddy_profiles ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_profiles (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  bio            text,
  cities         text[]      NOT NULL DEFAULT '{}',
  languages      text[]      NOT NULL DEFAULT '{}',
  hourly_rate    numeric(8,2),
  daily_rate     numeric(8,2),
  currency       text        NOT NULL DEFAULT 'USD',
  is_active      boolean     NOT NULL DEFAULT true,
  is_verified    boolean     NOT NULL DEFAULT false,
  avg_rating     numeric(3,2),
  review_count   integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_profiles ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rent_buddy_profiles_user_idx    ON rent_buddy_profiles(user_id);
CREATE INDEX IF NOT EXISTS rent_buddy_profiles_cities_idx  ON rent_buddy_profiles USING gin(cities);
CREATE INDEX IF NOT EXISTS rent_buddy_profiles_active_idx  ON rent_buddy_profiles(is_active) WHERE is_active;

CREATE POLICY "rb_profiles_public_read" ON rent_buddy_profiles
  FOR SELECT USING (true);
CREATE POLICY "rb_profiles_own" ON rent_buddy_profiles
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rb_profiles_service" ON rent_buddy_profiles
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_packages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_packages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id    uuid        NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  duration_hours integer,
  price       numeric(8,2) NOT NULL,
  currency    text        NOT NULL DEFAULT 'USD',
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_packages ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_packages_buddy_idx ON rent_buddy_packages(buddy_id);

CREATE POLICY "rb_packages_public_read" ON rent_buddy_packages
  FOR SELECT USING (true);
CREATE POLICY "rb_packages_own" ON rent_buddy_packages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = buddy_id AND user_id = auth.uid())
  );
CREATE POLICY "rb_packages_service" ON rent_buddy_packages
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_addons ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_addons (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id    uuid        NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  price       numeric(8,2) NOT NULL,
  currency    text        NOT NULL DEFAULT 'USD',
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_addons ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_addons_buddy_idx ON rent_buddy_addons(buddy_id);

CREATE POLICY "rb_addons_public_read" ON rent_buddy_addons
  FOR SELECT USING (true);
CREATE POLICY "rb_addons_own" ON rent_buddy_addons
  FOR ALL USING (
    EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = buddy_id AND user_id = auth.uid())
  );
CREATE POLICY "rb_addons_service" ON rent_buddy_addons
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_availability ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_availability (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id     uuid        NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  city         text        NOT NULL,
  date_from    date        NOT NULL,
  date_to      date        NOT NULL,
  is_blocked   boolean     NOT NULL DEFAULT false,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_availability ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_availability_buddy_idx ON rent_buddy_availability(buddy_id);
CREATE INDEX IF NOT EXISTS rb_availability_city_idx  ON rent_buddy_availability(city);
CREATE INDEX IF NOT EXISTS rb_availability_dates_idx ON rent_buddy_availability(date_from, date_to);

CREATE POLICY "rb_availability_public_read" ON rent_buddy_availability
  FOR SELECT USING (true);
CREATE POLICY "rb_availability_own" ON rent_buddy_availability
  FOR ALL USING (
    EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = buddy_id AND user_id = auth.uid())
  );
CREATE POLICY "rb_availability_service" ON rent_buddy_availability
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_saved ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_saved (
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id   uuid        NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, buddy_id)
);

ALTER TABLE rent_buddy_saved ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rb_saved_own" ON rent_buddy_saved
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rb_saved_service" ON rent_buddy_saved
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_waitlist ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_waitlist (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city       text        NOT NULL,
  date_from  date,
  date_to    date,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_waitlist ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_waitlist_user_idx ON rent_buddy_waitlist(user_id);
CREATE INDEX IF NOT EXISTS rb_waitlist_city_idx ON rent_buddy_waitlist(city);

CREATE POLICY "rb_waitlist_own" ON rent_buddy_waitlist
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rb_waitlist_service" ON rent_buddy_waitlist
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_applications ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_applications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  bio          text,
  cities       text[],
  languages    text[],
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  rejection_reason text
);

ALTER TABLE rent_buddy_applications ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_applications_applicant_idx ON rent_buddy_applications(applicant_id);
CREATE INDEX IF NOT EXISTS rb_applications_status_idx    ON rent_buddy_applications(status);

CREATE POLICY "rb_applications_own" ON rent_buddy_applications
  FOR ALL USING (auth.uid() = applicant_id) WITH CHECK (auth.uid() = applicant_id);
CREATE POLICY "rb_applications_service" ON rent_buddy_applications
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_bookings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_bookings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  traveler_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id        uuid        NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  package_id      uuid        REFERENCES rent_buddy_packages(id) ON DELETE SET NULL,
  city            text        NOT NULL,
  date_from       date        NOT NULL,
  date_to         date        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'cancelled', 'disputed')),
  total_price     numeric(10,2),
  currency        text        NOT NULL DEFAULT 'USD',
  note            text,
  cancelled_by    uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_bookings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_bookings_traveler_idx ON rent_buddy_bookings(traveler_id);
CREATE INDEX IF NOT EXISTS rb_bookings_buddy_idx    ON rent_buddy_bookings(buddy_id);
CREATE INDEX IF NOT EXISTS rb_bookings_status_idx   ON rent_buddy_bookings(status);
CREATE INDEX IF NOT EXISTS rb_bookings_dates_idx    ON rent_buddy_bookings(date_from, date_to);

CREATE POLICY "rb_bookings_traveler" ON rent_buddy_bookings
  FOR ALL USING (auth.uid() = traveler_id);
CREATE POLICY "rb_bookings_buddy" ON rent_buddy_bookings
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = buddy_id AND user_id = auth.uid())
  );
CREATE POLICY "rb_bookings_service" ON rent_buddy_bookings
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_booking_extensions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_booking_extensions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  extra_days   integer     NOT NULL,
  extra_price  numeric(8,2),
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_booking_extensions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_extensions_booking_idx ON rent_buddy_booking_extensions(booking_id);

CREATE POLICY "rb_extensions_party" ON rent_buddy_booking_extensions
  FOR ALL USING (
    auth.uid() = requested_by OR
    EXISTS (
      SELECT 1 FROM rent_buddy_bookings b
      WHERE b.id = booking_id AND (b.traveler_id = auth.uid() OR
        EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = b.buddy_id AND user_id = auth.uid()))
    )
  );
CREATE POLICY "rb_extensions_service" ON rent_buddy_booking_extensions
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_route_stops ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_route_stops (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  stop_order  integer     NOT NULL,
  location    text        NOT NULL,
  lat         double precision,
  lng         double precision,
  eta         timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_route_stops ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_route_stops_booking_idx ON rent_buddy_route_stops(booking_id);

CREATE POLICY "rb_route_stops_party" ON rent_buddy_route_stops
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM rent_buddy_bookings b
      WHERE b.id = booking_id AND (b.traveler_id = auth.uid() OR
        EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = b.buddy_id AND user_id = auth.uid()))
    )
  );
CREATE POLICY "rb_route_stops_service" ON rent_buddy_route_stops
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_route_change_requests ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_route_change_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  description  text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_route_change_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_route_changes_booking_idx ON rent_buddy_route_change_requests(booking_id);

CREATE POLICY "rb_route_changes_party" ON rent_buddy_route_change_requests
  FOR ALL USING (
    auth.uid() = requested_by OR
    EXISTS (
      SELECT 1 FROM rent_buddy_bookings b
      WHERE b.id = booking_id AND (b.traveler_id = auth.uid() OR
        EXISTS (SELECT 1 FROM rent_buddy_profiles WHERE id = b.buddy_id AND user_id = auth.uid()))
    )
  );
CREATE POLICY "rb_route_changes_service" ON rent_buddy_route_change_requests
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_safety_checkins ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_safety_checkins (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'ok'
              CHECK (status IN ('ok', 'flagged', 'missed')),
  checked_at  timestamptz NOT NULL DEFAULT now(),
  lat         double precision,
  lng         double precision,
  note        text
);

ALTER TABLE rent_buddy_safety_checkins ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_safety_checkins_booking_idx ON rent_buddy_safety_checkins(booking_id);
CREATE INDEX IF NOT EXISTS rb_safety_checkins_user_idx    ON rent_buddy_safety_checkins(user_id);

CREATE POLICY "rb_safety_checkins_own" ON rent_buddy_safety_checkins
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rb_safety_checkins_service" ON rent_buddy_safety_checkins
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_safety_events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_safety_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  reported_by uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type  text        NOT NULL,
  description text,
  severity    text        NOT NULL DEFAULT 'low'
              CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  resolved    boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_safety_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_safety_events_booking_idx ON rent_buddy_safety_events(booking_id);

CREATE POLICY "rb_safety_events_service" ON rent_buddy_safety_events
  FOR ALL TO service_role USING (true);
CREATE POLICY "rb_safety_events_own" ON rent_buddy_safety_events
  FOR SELECT USING (auth.uid() = reported_by);

-- ── rent_buddy_user_limits ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_user_limits (
  user_id              uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  max_active_bookings  integer NOT NULL DEFAULT 3,
  max_pending_requests integer NOT NULL DEFAULT 5,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_user_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rb_user_limits_own" ON rent_buddy_user_limits
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "rb_user_limits_service" ON rent_buddy_user_limits
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_emergency_contacts_snapshot ────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_emergency_contacts_snapshot (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contacts    jsonb       NOT NULL DEFAULT '[]',
  captured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_emergency_contacts_snapshot ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_emergency_booking_idx ON rent_buddy_emergency_contacts_snapshot(booking_id);

CREATE POLICY "rb_emergency_own" ON rent_buddy_emergency_contacts_snapshot
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rb_emergency_service" ON rent_buddy_emergency_contacts_snapshot
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_reviews ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_reviews (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  reviewer_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reviewee_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating      integer     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text,
  is_public   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, reviewer_id)
);

ALTER TABLE rent_buddy_reviews ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_reviews_reviewee_idx ON rent_buddy_reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS rb_reviews_booking_idx  ON rent_buddy_reviews(booking_id);

CREATE POLICY "rb_reviews_public_read" ON rent_buddy_reviews
  FOR SELECT USING (is_public);
CREATE POLICY "rb_reviews_own_insert" ON rent_buddy_reviews
  FOR INSERT WITH CHECK (auth.uid() = reviewer_id);
CREATE POLICY "rb_reviews_service" ON rent_buddy_reviews
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_disputes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_disputes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid        NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  raised_by    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason       text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'under_review', 'resolved', 'closed')),
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

ALTER TABLE rent_buddy_disputes ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_disputes_booking_idx ON rent_buddy_disputes(booking_id);

CREATE POLICY "rb_disputes_own" ON rent_buddy_disputes
  FOR ALL USING (auth.uid() = raised_by) WITH CHECK (auth.uid() = raised_by);
CREATE POLICY "rb_disputes_service" ON rent_buddy_disputes
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_policy_flags ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_policy_flags (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  flag_type   text        NOT NULL,
  details     jsonb,
  flagged_at  timestamptz NOT NULL DEFAULT now(),
  resolved    boolean     NOT NULL DEFAULT false,
  resolved_at timestamptz
);

ALTER TABLE rent_buddy_policy_flags ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_policy_flags_user_idx ON rent_buddy_policy_flags(user_id);

CREATE POLICY "rb_policy_flags_service" ON rent_buddy_policy_flags
  FOR ALL TO service_role USING (true);

-- ── rent_buddy_admin_actions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  target_type text        NOT NULL,
  target_id   text        NOT NULL,
  action      text        NOT NULL,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS rb_admin_actions_target_idx ON rent_buddy_admin_actions(target_type, target_id);

CREATE POLICY "rb_admin_actions_service" ON rent_buddy_admin_actions
  FOR ALL TO service_role USING (true);

-- ── Feature flag seed ─────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('rent_buddy_enabled', false, 'Enable Rent-a-Buddy marketplace feature')
ON CONFLICT (flag) DO NOTHING;
