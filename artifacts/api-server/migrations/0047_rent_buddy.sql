-- Migration 0047: Rent a Buddy marketplace tables
-- Creates all rent_buddy_* tables, RLS policies, and seeds the feature flag.

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE rent_buddy_status AS ENUM ('pending','active','paused','rejected','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_application_status AS ENUM ('pending','under_review','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_booking_status AS ENUM ('pending','confirmed','in_progress','completed','cancelled','disputed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_payment_mode AS ENUM ('full_in_app','deposit_plus_cash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_safety_status AS ENUM ('normal','check_requested','uncomfortable','emergency');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_flag_source AS ENUM ('message','booking_note','profile','route_change','report','payment','review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_flag_severity AS ENUM ('low','medium','high','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_flag_status AS ENUM ('open','reviewing','resolved','dismissed','escalated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_dispute_reason AS ENUM ('cash_balance_disagreement','no_show','harassment','policy_violation','route_violation','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_dispute_status AS ENUM ('open','reviewing','resolved','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_checkin_type AS ENUM ('arrival','comfort_30min','check_ok','uncomfortable','end_early','contact_support','start_safe_return','emergency_phrase');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_safety_event_type AS ENUM ('route_change_unapproved','comfort_check_distress','emergency_phrase_triggered','off_app_payment_attempt','feel_unsafe','end_early','no_show','harassment_reported','private_meetup_violation','unapproved_extra_guest','abandoned_booking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_safety_event_status AS ENUM ('open','reviewing','resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── rent_buddy_profiles ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  display_name           TEXT,
  tagline                TEXT,
  bio                    TEXT,
  intro_video_url        TEXT,
  languages              TEXT[]   NOT NULL DEFAULT '{}',
  city                   TEXT     NOT NULL,
  country                TEXT,
  categories             TEXT[]   NOT NULL DEFAULT '{}',
  hourly_rate_usd        NUMERIC(10,2),
  status                 rent_buddy_status NOT NULL DEFAULT 'pending',
  admin_status           TEXT     NOT NULL DEFAULT 'active',  -- 'active'|'restricted'|'disabled'
  verified               BOOLEAN  NOT NULL DEFAULT FALSE,
  verified_at            TIMESTAMPTZ,
  average_rating         NUMERIC(3,2),
  review_count           INT      NOT NULL DEFAULT 0,
  completed_bookings     INT      NOT NULL DEFAULT 0,
  response_time_h        NUMERIC(4,1),
  cover_photo_url        TEXT,
  gallery_urls           TEXT[]   NOT NULL DEFAULT '{}',
  vibe_tags              TEXT[]   NOT NULL DEFAULT '{}',
  safety_badges          TEXT[]   NOT NULL DEFAULT '{}',
  buddy_level            TEXT     NOT NULL DEFAULT 'new',  -- 'new'|'rising'|'pro'|'elite'
  -- Per-category approvals stored as JSONB: {"nightlife":true,"group":false,...}
  category_approvals     JSONB    NOT NULL DEFAULT '{}',
  -- New-buddy restriction flags
  new_buddy_public_only  BOOLEAN  NOT NULL DEFAULT TRUE,
  new_buddy_daytime_only BOOLEAN  NOT NULL DEFAULT TRUE,
  new_buddy_max_hours    INT      NOT NULL DEFAULT 2,
  max_group_size         INT      NOT NULL DEFAULT 4,
  preferred_meetup_zones TEXT[]   NOT NULL DEFAULT '{}',
  trust_score_override   INT,
  risk_hold              BOOLEAN  NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE rent_buddy_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_profiles_read   ON rent_buddy_profiles FOR SELECT USING (TRUE);
CREATE POLICY rb_profiles_own    ON rent_buddy_profiles FOR ALL   USING (auth.uid() = user_id);
CREATE POLICY rb_profiles_svc    ON rent_buddy_profiles FOR ALL   USING (auth.role() = 'service_role');

-- ── rent_buddy_applications ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_applications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status                 rent_buddy_application_status NOT NULL DEFAULT 'pending',
  city                   TEXT NOT NULL,
  country                TEXT,
  categories             TEXT[] NOT NULL DEFAULT '{}',
  languages              TEXT[] NOT NULL DEFAULT '{}',
  motivation             TEXT,
  id_verification_ref    TEXT,
  social_links           JSONB NOT NULL DEFAULT '{}',
  availability_blocks    JSONB NOT NULL DEFAULT '[]',
  policy_accepted        BOOLEAN NOT NULL DEFAULT FALSE,
  policy_accepted_at     TIMESTAMPTZ,
  review_notes           TEXT,
  reviewed_by            UUID REFERENCES profiles(id),
  reviewed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE rent_buddy_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_apps_own ON rent_buddy_applications FOR ALL USING (auth.uid() = user_id);
CREATE POLICY rb_apps_svc ON rent_buddy_applications FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_availability ───────────────────────────────────────────────────

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
CREATE POLICY rb_avail_read ON rent_buddy_availability FOR SELECT USING (TRUE);
CREATE POLICY rb_avail_own  ON rent_buddy_availability FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY rb_avail_svc  ON rent_buddy_availability FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_packages ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_packages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id     UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  category     TEXT NOT NULL,
  duration_h   NUMERIC(4,1) NOT NULL,
  price_usd    NUMERIC(10,2) NOT NULL,
  max_group    INT NOT NULL DEFAULT 1,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_pkg_read ON rent_buddy_packages FOR SELECT USING (TRUE);
CREATE POLICY rb_pkg_own  ON rent_buddy_packages FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY rb_pkg_svc  ON rent_buddy_packages FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_addons ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_addons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id     UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  price_usd    NUMERIC(10,2) NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_addon_read ON rent_buddy_addons FOR SELECT USING (TRUE);
CREATE POLICY rb_addon_own  ON rent_buddy_addons FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY rb_addon_svc  ON rent_buddy_addons FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_saved ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_saved (
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id   UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, buddy_id)
);

ALTER TABLE rent_buddy_saved ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_saved_own ON rent_buddy_saved FOR ALL USING (auth.uid() = user_id);
CREATE POLICY rb_saved_svc ON rent_buddy_saved FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_waitlist ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city       TEXT NOT NULL,
  category   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, city)
);

ALTER TABLE rent_buddy_waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_waitlist_own ON rent_buddy_waitlist FOR ALL USING (auth.uid() = user_id);
CREATE POLICY rb_waitlist_svc ON rent_buddy_waitlist FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_bookings ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_bookings (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id                        UUID NOT NULL REFERENCES rent_buddy_profiles(id),
  traveler_id                     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  package_id                      UUID REFERENCES rent_buddy_packages(id),
  trip_id                         UUID,
  booking_date                    DATE NOT NULL,
  start_time                      TIME,
  duration_h                      NUMERIC(4,1) NOT NULL,
  group_size                      INT NOT NULL DEFAULT 1,
  city                            TEXT NOT NULL,
  category                        TEXT NOT NULL,
  notes                           TEXT,
  route_plan                      JSONB NOT NULL DEFAULT '[]',
  payment_mode                    rent_buddy_payment_mode NOT NULL DEFAULT 'full_in_app',
  total_usd                       NUMERIC(10,2) NOT NULL DEFAULT 0,
  deposit_usd                     NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_balance_usd                NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_balance_confirmed_by_buddy     BOOLEAN,
  cash_balance_confirmed_by_traveler  BOOLEAN,
  cash_balance_confirmed_at       TIMESTAMPTZ,
  status                          rent_buddy_booking_status NOT NULL DEFAULT 'pending',
  safety_status                   rent_buddy_safety_status NOT NULL DEFAULT 'normal',
  dispute_reason                  TEXT,
  cancelled_at                    TIMESTAMPTZ,
  confirmed_at                    TIMESTAMPTZ,
  started_at                      TIMESTAMPTZ,
  completed_at                    TIMESTAMPTZ,
  telegraph_thread_id             UUID,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_booking_parties ON rent_buddy_bookings FOR SELECT
  USING (
    auth.uid() = traveler_id OR
    buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
  );
CREATE POLICY rb_booking_traveler_ins ON rent_buddy_bookings FOR INSERT WITH CHECK (auth.uid() = traveler_id);
CREATE POLICY rb_booking_svc ON rent_buddy_bookings FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_bookings_traveler_idx ON rent_buddy_bookings(traveler_id);
CREATE INDEX IF NOT EXISTS rb_bookings_buddy_idx    ON rent_buddy_bookings(buddy_id);
CREATE INDEX IF NOT EXISTS rb_bookings_status_idx   ON rent_buddy_bookings(status);

-- ── rent_buddy_booking_extensions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_booking_extensions (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                       UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  extra_hours                      NUMERIC(4,1) NOT NULL,
  extra_usd                        NUMERIC(10,2) NOT NULL,
  payment_mode                     rent_buddy_payment_mode NOT NULL DEFAULT 'full_in_app',
  confirmed_by_buddy               BOOLEAN,
  confirmed_by_traveler            BOOLEAN,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_booking_extensions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_ext_parties ON rent_buddy_booking_extensions FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY rb_ext_svc ON rent_buddy_booking_extensions FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_route_stops ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_route_stops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  stop_order INT NOT NULL,
  name       TEXT NOT NULL,
  notes      TEXT,
  eta        TIME,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_route_stops ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_stops_parties ON rent_buddy_route_stops FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY rb_stops_svc ON rent_buddy_route_stops FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_route_change_requests ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_route_change_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by        UUID NOT NULL REFERENCES profiles(id),
  old_stops_json      JSONB NOT NULL DEFAULT '[]',
  new_stops_json      JSONB NOT NULL DEFAULT '[]',
  reason              TEXT,
  traveler_response   TEXT,  -- 'approved'|'declined'|null
  responded_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_route_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_route_chg_parties ON rent_buddy_route_change_requests FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY rb_route_chg_svc ON rent_buddy_route_change_requests FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_safety_checkins ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_safety_checkins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES profiles(id),
  checkin_type  rent_buddy_checkin_type NOT NULL,
  response      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_safety_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_checkin_own ON rent_buddy_safety_checkins FOR ALL USING (auth.uid() = user_id);
CREATE POLICY rb_checkin_svc ON rent_buddy_safety_checkins FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_safety_events ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_safety_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES rent_buddy_bookings(id),
  actor_user_id    UUID NOT NULL REFERENCES profiles(id),
  target_user_id   UUID REFERENCES profiles(id),
  event_type       rent_buddy_safety_event_type NOT NULL,
  event_status     rent_buddy_safety_event_status NOT NULL DEFAULT 'open',
  metadata         JSONB NOT NULL DEFAULT '{}',
  admin_notes      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_safety_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_safety_evt_own ON rent_buddy_safety_events FOR SELECT USING (auth.uid() = actor_user_id OR auth.uid() = target_user_id);
CREATE POLICY rb_safety_evt_svc ON rent_buddy_safety_events FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_safety_evt_booking_idx ON rent_buddy_safety_events(booking_id);
CREATE INDEX IF NOT EXISTS rb_safety_evt_status_idx  ON rent_buddy_safety_events(event_status);

-- ── rent_buddy_user_limits ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_user_limits (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rent_buddy_disabled          BOOLEAN NOT NULL DEFAULT FALSE,
  buddy_disabled               BOOLEAN NOT NULL DEFAULT FALSE,
  traveler_booking_disabled    BOOLEAN NOT NULL DEFAULT FALSE,
  nightlife_disabled           BOOLEAN NOT NULL DEFAULT FALSE,
  cash_balance_disabled        BOOLEAN NOT NULL DEFAULT FALSE,
  max_booking_duration_minutes INT,
  public_meetup_required       BOOLEAN NOT NULL DEFAULT FALSE,
  full_in_app_payment_required BOOLEAN NOT NULL DEFAULT FALSE,
  reason                       TEXT,
  created_by_admin_id          UUID REFERENCES profiles(id),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE rent_buddy_user_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_limits_own ON rent_buddy_user_limits FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rb_limits_svc ON rent_buddy_user_limits FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_emergency_contacts_snapshot ────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_emergency_contacts_snapshot (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id              UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES profiles(id),
  trusted_circle_shared   BOOLEAN NOT NULL DEFAULT FALSE,
  safe_return_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_contact_count INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_emergency_contacts_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_ec_snap_own ON rent_buddy_emergency_contacts_snapshot FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rb_ec_snap_svc ON rent_buddy_emergency_contacts_snapshot FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_reviews ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  reviewer_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reviewee_id         UUID NOT NULL REFERENCES profiles(id),
  role                TEXT NOT NULL,  -- 'traveler'|'buddy'
  rating              NUMERIC(3,2) NOT NULL,
  safety_score        INT,
  communication_score INT,
  punctuality_score   INT,
  body                TEXT,
  private_admin_note  TEXT,
  is_public           BOOLEAN NOT NULL DEFAULT FALSE,
  blind_until         TIMESTAMPTZ,
  photos              TEXT[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, reviewer_id)
);

ALTER TABLE rent_buddy_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_review_own ON rent_buddy_reviews FOR SELECT USING (auth.uid() = reviewer_id OR (is_public AND blind_until < NOW()));
CREATE POLICY rb_review_svc ON rent_buddy_reviews FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_disputes ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  raised_by        UUID NOT NULL REFERENCES profiles(id),
  reason           rent_buddy_dispute_reason NOT NULL,
  status           rent_buddy_dispute_status NOT NULL DEFAULT 'open',
  resolution_note  TEXT,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_dispute_parties ON rent_buddy_disputes FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY rb_dispute_svc ON rent_buddy_disputes FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_policy_flags ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_policy_flags (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           UUID REFERENCES rent_buddy_bookings(id),
  reporter_user_id     UUID REFERENCES profiles(id),
  flagged_user_id      UUID REFERENCES profiles(id),
  source_type          rent_buddy_flag_source NOT NULL,
  source_id            TEXT,
  category             TEXT NOT NULL,  -- 'escort'|'adult_service'|'drug'|etc.
  severity             rent_buddy_flag_severity NOT NULL DEFAULT 'low',
  matched_text_excerpt TEXT,
  status               rent_buddy_flag_status NOT NULL DEFAULT 'open',
  admin_notes          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ
);

ALTER TABLE rent_buddy_policy_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_flags_svc ON rent_buddy_policy_flags FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_flags_user_idx     ON rent_buddy_policy_flags(flagged_user_id);
CREATE INDEX IF NOT EXISTS rb_flags_booking_idx  ON rent_buddy_policy_flags(booking_id);
CREATE INDEX IF NOT EXISTS rb_flags_severity_idx ON rent_buddy_policy_flags(severity);
CREATE INDEX IF NOT EXISTS rb_flags_status_idx   ON rent_buddy_policy_flags(status);

-- ── rent_buddy_admin_actions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES profiles(id),
  target_type   TEXT NOT NULL,  -- 'user'|'booking'|'application'|'flag'|'dispute'
  target_id     UUID NOT NULL,
  action        TEXT NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_admin_actions_svc ON rent_buddy_admin_actions FOR ALL USING (auth.role() = 'service_role');

-- ── Feature flag seed ─────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('rent_buddy_enabled', FALSE, 'Rent a Buddy marketplace feature gate')
ON CONFLICT (flag) DO NOTHING;
