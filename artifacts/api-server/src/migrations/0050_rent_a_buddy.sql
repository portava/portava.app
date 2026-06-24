-- Migration: 0050_rent_a_buddy.sql
-- Creates core Rent a Buddy marketplace tables and seeds the feature flag.

-- ── Buddy Profiles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  display_name     text,
  tagline          text,
  bio              text,
  languages        text[] NOT NULL DEFAULT '{}',
  city             text NOT NULL,
  country          text,
  categories       text[] NOT NULL DEFAULT '{}',
  hourly_rate_usd  numeric(8,2),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','paused','rejected','suspended')),
  verified         boolean NOT NULL DEFAULT false,
  verified_at      timestamptz,
  average_rating   numeric(3,2),
  review_count     integer NOT NULL DEFAULT 0,
  response_time_h  numeric(5,2),
  cover_photo_url  text,
  gallery_urls     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE buddy_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_profiles_select ON buddy_profiles FOR SELECT USING (true);
CREATE POLICY buddy_profiles_insert ON buddy_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY buddy_profiles_update ON buddy_profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY buddy_profiles_delete ON buddy_profiles FOR DELETE USING (auth.uid() = user_id);

-- ── Buddy Packages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id      uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  category      text NOT NULL,
  duration_h    numeric(5,2) NOT NULL,
  price_usd     numeric(8,2) NOT NULL,
  max_group     integer NOT NULL DEFAULT 4,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE buddy_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_packages_select ON buddy_packages FOR SELECT USING (true);
CREATE POLICY buddy_packages_insert ON buddy_packages FOR INSERT WITH CHECK (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_packages_update ON buddy_packages FOR UPDATE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_packages_delete ON buddy_packages FOR DELETE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);

-- ── Buddy Add-ons ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id    uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  price_usd   numeric(8,2) NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE buddy_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_addons_select ON buddy_addons FOR SELECT USING (true);
CREATE POLICY buddy_addons_insert ON buddy_addons FOR INSERT WITH CHECK (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_addons_update ON buddy_addons FOR UPDATE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_addons_delete ON buddy_addons FOR DELETE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);

-- ── Buddy Availability ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id      uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE CASCADE,
  date          date NOT NULL,
  time_slots    text[] NOT NULL DEFAULT '{}',
  is_available  boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buddy_id, date)
);

ALTER TABLE buddy_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_availability_select ON buddy_availability FOR SELECT USING (true);
CREATE POLICY buddy_availability_insert ON buddy_availability FOR INSERT WITH CHECK (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_availability_update ON buddy_availability FOR UPDATE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_availability_delete ON buddy_availability FOR DELETE USING (
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);

-- ── Buddy Bookings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE RESTRICT,
  traveler_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  package_id      uuid REFERENCES buddy_packages(id) ON DELETE SET NULL,
  trip_id         uuid REFERENCES trips(id) ON DELETE SET NULL,
  booking_date    date NOT NULL,
  start_time      time,
  duration_h      numeric(5,2) NOT NULL,
  group_size      integer NOT NULL DEFAULT 1,
  city            text NOT NULL,
  category        text NOT NULL,
  notes           text,
  total_usd       numeric(8,2) NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','in_progress','completed','cancelled','disputed')),
  cancelled_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  cancel_reason   text,
  cancelled_at    timestamptz,
  confirmed_at    timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE buddy_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_bookings_select ON buddy_bookings FOR SELECT USING (
  auth.uid() = traveler_id OR
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);
CREATE POLICY buddy_bookings_insert ON buddy_bookings FOR INSERT WITH CHECK (auth.uid() = traveler_id);
CREATE POLICY buddy_bookings_update ON buddy_bookings FOR UPDATE USING (
  auth.uid() = traveler_id OR
  auth.uid() = (SELECT user_id FROM buddy_profiles WHERE id = buddy_id)
);

-- ── Buddy Reviews ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES buddy_bookings(id) ON DELETE CASCADE,
  reviewer_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id      uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE CASCADE,
  rating        integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          text,
  photos        text[] NOT NULL DEFAULT '{}',
  is_public     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, reviewer_id)
);

ALTER TABLE buddy_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_reviews_select ON buddy_reviews FOR SELECT USING (is_public OR auth.uid() = reviewer_id);
CREATE POLICY buddy_reviews_insert ON buddy_reviews FOR INSERT WITH CHECK (auth.uid() = reviewer_id);
CREATE POLICY buddy_reviews_update ON buddy_reviews FOR UPDATE USING (auth.uid() = reviewer_id);
CREATE POLICY buddy_reviews_delete ON buddy_reviews FOR DELETE USING (auth.uid() = reviewer_id);

-- ── Buddy Applications ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','under_review','approved','rejected')),
  city            text NOT NULL,
  country         text,
  categories      text[] NOT NULL DEFAULT '{}',
  languages       text[] NOT NULL DEFAULT '{}',
  motivation      text,
  social_links    jsonb NOT NULL DEFAULT '{}',
  reviewer_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  review_notes    text,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE buddy_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_applications_select ON buddy_applications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY buddy_applications_insert ON buddy_applications FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY buddy_applications_update ON buddy_applications FOR UPDATE USING (auth.uid() = user_id);

-- ── Buddy Saved ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_saved (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id   uuid NOT NULL REFERENCES buddy_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, buddy_id)
);

ALTER TABLE buddy_saved ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_saved_select ON buddy_saved FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY buddy_saved_insert ON buddy_saved FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY buddy_saved_delete ON buddy_saved FOR DELETE USING (auth.uid() = user_id);

-- ── Buddy Waitlist ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buddy_waitlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city       text NOT NULL,
  category   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, city)
);

ALTER TABLE buddy_waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY buddy_waitlist_select ON buddy_waitlist FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY buddy_waitlist_insert ON buddy_waitlist FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY buddy_waitlist_delete ON buddy_waitlist FOR DELETE USING (auth.uid() = user_id);

-- ── Feature flag seed ─────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description)
VALUES ('rent_buddy_enabled', false, 'Rent a Buddy marketplace')
ON CONFLICT (flag) DO NOTHING;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS buddy_profiles_city_idx ON buddy_profiles (city);
CREATE INDEX IF NOT EXISTS buddy_profiles_status_idx ON buddy_profiles (status);
CREATE INDEX IF NOT EXISTS buddy_bookings_traveler_idx ON buddy_bookings (traveler_id);
CREATE INDEX IF NOT EXISTS buddy_bookings_buddy_idx ON buddy_bookings (buddy_id);
CREATE INDEX IF NOT EXISTS buddy_bookings_date_idx ON buddy_bookings (booking_date);
CREATE INDEX IF NOT EXISTS buddy_reviews_buddy_idx ON buddy_reviews (buddy_id);
