-- Migration 0134: Rent a Buddy — full schema rebuild (drift fix)
--
-- The live rent_buddy_* tables kept a pre-0047 legacy shape, so every rent-a-buddy
-- route silently failed against the real database. All drifted tables were empty
-- (verified 2026-07-16), so this rebuilds them from the canonical chain:
--   0047 -> 0048_rollout -> 0048_marketplace -> 0051 -> 0107 -> 0108(fixed) ->
--   0109 -> 0110 -> 0111 -> 0112 -> 0113 -> 0133 -> route-alignment ALTERs
-- 0108's invalid `ADD CONSTRAINT IF NOT EXISTS` is replaced with a guarded DO block.
--
-- NOTE: apply each PART as a separate statement/transaction (ALTER TYPE ... ADD
-- VALUE on pre-existing enums cannot be used in the same transaction that adds it).
-- Applied via Supabase Management API, one PART per request.

-- ── PART A: Preamble — verify-empty guard, drop drifted tables, prep kept tables ──
--
-- The live rent_buddy_* tables kept a pre-0047 legacy shape (rent_buddy_profiles
-- had 14 old columns; rent_buddy_bookings used date_from/date_to). All drifted
-- tables were verified empty on 2026-07-16 before this rebuild; the guard below
-- re-verifies at run time and aborts if any row appeared since.
--
-- Kept (have data, correct-enough shape, aligned via ALTER below):
--   rent_buddy_city_rollouts, rent_buddy_fee_rules, rent_buddy_global_controls

DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rent_buddy_profiles','rent_buddy_applications','rent_buddy_availability',
    'rent_buddy_packages','rent_buddy_addons','rent_buddy_saved','rent_buddy_waitlist',
    'rent_buddy_bookings','rent_buddy_booking_extensions','rent_buddy_route_stops',
    'rent_buddy_route_change_requests','rent_buddy_safety_checkins','rent_buddy_safety_events',
    'rent_buddy_user_limits','rent_buddy_emergency_contacts_snapshot','rent_buddy_reviews',
    'rent_buddy_disputes','rent_buddy_policy_flags','rent_buddy_admin_actions',
    'buddy_availability_exceptions'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('SELECT COUNT(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'drifted table % is not empty (% rows) — manual migration required', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;

-- Drop drifted tables (CASCADE drops dependent views/FKs). All verified empty above.
DROP TABLE IF EXISTS
  rent_buddy_emergency_contacts_snapshot,
  rent_buddy_booking_extensions,
  rent_buddy_route_stops,
  rent_buddy_route_change_requests,
  rent_buddy_safety_checkins,
  rent_buddy_safety_events,
  rent_buddy_reviews,
  rent_buddy_disputes,
  rent_buddy_policy_flags,
  rent_buddy_admin_actions,
  rent_buddy_user_limits,
  rent_buddy_bookings,
  rent_buddy_saved,
  rent_buddy_waitlist,
  rent_buddy_availability,
  buddy_availability_exceptions,
  rent_buddy_packages,
  rent_buddy_addons,
  rent_buddy_applications,
  rent_buddy_profiles
CASCADE;

-- Drop legacy spec-name views if they exist (recreated by 0108 section below).
DROP VIEW IF EXISTS buddy_booking_checkins, buddy_change_requests, buddy_favorites,
  buddy_profiles, buddy_availability, buddy_reviews, buddy_disputes, buddy_booking_requests CASCADE;

-- Kept tables: drop existing RLS policies so the canonical CREATE POLICY
-- statements below can re-run without duplicate errors.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('rent_buddy_city_rollouts','rent_buddy_fee_rules','rent_buddy_global_controls')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- Align kept tables with the canonical shapes (live versions lack these columns).
ALTER TABLE rent_buddy_city_rollouts
  ADD COLUMN IF NOT EXISTS country            TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by  UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS target_launch_date DATE,
  ADD COLUMN IF NOT EXISTS buddy_cap          INT;

ALTER TABLE rent_buddy_global_controls
  ADD COLUMN IF NOT EXISTS updated_by_admin_id UUID REFERENCES profiles(id);

-- ======= PART: 0047_rent_buddy =======

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

-- ======= PART: 0048_rent_buddy_rollout =======

-- Migration 0048: Rent a Buddy rollout & launch control tables
-- Creates per-city rollout tracking, beta access controls, QA checklists,
-- audit logs, global kill switches, and seeds 9 MVP feature flags.

-- ── Enums ──────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE rent_buddy_city_status AS ENUM (
    'disabled',
    'waitlist_only',
    'buddy_applications_open',
    'internal_testing',
    'beta_testing',
    'public_mvp',
    'paused',
    'suspended'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_beta_access_type AS ENUM ('invited', 'staff', 'influencer', 'tester');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_beta_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rent_buddy_checklist_status AS ENUM ('pending', 'in_progress', 'passed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── is_test_booking on rent_buddy_bookings ────────────────────────────────────

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS is_test_booking BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS rb_bookings_test_idx
  ON rent_buddy_bookings(is_test_booking) WHERE is_test_booking = TRUE;

-- ── rent_buddy_city_rollouts ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_city_rollouts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city                  TEXT NOT NULL,
  country               TEXT,
  status                rent_buddy_city_status NOT NULL DEFAULT 'disabled',
  status_changed_at     TIMESTAMPTZ,
  status_changed_by     UUID REFERENCES profiles(id),
  target_launch_date    DATE,
  buddy_cap             INT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (city)
);

ALTER TABLE rent_buddy_city_rollouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_rollout_svc ON rent_buddy_city_rollouts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY rb_rollout_public_read ON rent_buddy_city_rollouts FOR SELECT USING (TRUE);

CREATE INDEX IF NOT EXISTS rb_city_rollouts_status_idx ON rent_buddy_city_rollouts(status);
CREATE INDEX IF NOT EXISTS rb_city_rollouts_city_idx ON rent_buddy_city_rollouts(city);

-- ── rent_buddy_beta_access ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_beta_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city            TEXT NOT NULL,
  access_type     rent_buddy_beta_access_type NOT NULL DEFAULT 'invited',
  status          rent_buddy_beta_status NOT NULL DEFAULT 'active',
  invited_by      UUID REFERENCES profiles(id),
  notes           TEXT,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, city)
);

ALTER TABLE rent_buddy_beta_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_beta_own_read  ON rent_buddy_beta_access FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rb_beta_svc       ON rent_buddy_beta_access FOR ALL   USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_beta_access_user_idx   ON rent_buddy_beta_access(user_id);
CREATE INDEX IF NOT EXISTS rb_beta_access_city_idx   ON rent_buddy_beta_access(city);
CREATE INDEX IF NOT EXISTS rb_beta_access_status_idx ON rent_buddy_beta_access(status);

-- ── rent_buddy_launch_checklists ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_launch_checklists (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_rollout_id       UUID NOT NULL REFERENCES rent_buddy_city_rollouts(id) ON DELETE CASCADE,
  checklist_status      rent_buddy_checklist_status NOT NULL DEFAULT 'pending',
  -- Required QA items
  policy_scan_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  safety_flow_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  booking_flow_passed       BOOLEAN NOT NULL DEFAULT FALSE,
  telegraph_passed          BOOLEAN NOT NULL DEFAULT FALSE,
  trust_score_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  payment_flow_passed       BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_passed         BOOLEAN NOT NULL DEFAULT FALSE,
  waitlist_flow_passed      BOOLEAN NOT NULL DEFAULT FALSE,
  buddy_application_passed  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Meta
  tested_by_admin_id    UUID REFERENCES profiles(id),
  tested_at             TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (city_rollout_id)
);

ALTER TABLE rent_buddy_launch_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_checklist_svc ON rent_buddy_launch_checklists FOR ALL USING (auth.role() = 'service_role');

-- ── rent_buddy_launch_audit_logs ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_launch_audit_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_rollout_id   UUID REFERENCES rent_buddy_city_rollouts(id),
  admin_id          UUID NOT NULL REFERENCES profiles(id),
  action            TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT,
  override_reason   TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_launch_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_audit_svc ON rent_buddy_launch_audit_logs FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_audit_city_idx    ON rent_buddy_launch_audit_logs(city_rollout_id);
CREATE INDEX IF NOT EXISTS rb_audit_admin_idx   ON rent_buddy_launch_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS rb_audit_created_idx ON rent_buddy_launch_audit_logs(created_at DESC);

-- ── rent_buddy_global_controls ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_global_controls (
  id                       INT PRIMARY KEY DEFAULT 1,
  all_bookings_paused      BOOLEAN NOT NULL DEFAULT FALSE,
  applications_paused      BOOLEAN NOT NULL DEFAULT FALSE,
  cash_balance_paused      BOOLEAN NOT NULL DEFAULT FALSE,
  nightlife_paused         BOOLEAN NOT NULL DEFAULT FALSE,
  force_full_in_app        BOOLEAN NOT NULL DEFAULT FALSE,
  force_public_meetup      BOOLEAN NOT NULL DEFAULT FALSE,
  force_delayed_posting    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_admin_id      UUID REFERENCES profiles(id),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row_only CHECK (id = 1)
);

-- Seed the single row
INSERT INTO rent_buddy_global_controls (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE rent_buddy_global_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_global_svc ON rent_buddy_global_controls FOR ALL USING (auth.role() = 'service_role');

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('RENT_BUDDY_MVP_MODE',                FALSE, 'MVP mode: restrict categories to city/language/arrival/shopping/content; block nightlife, group, concierge, packages, bidding, instant buddy, cash balance in high-risk cities, private meetup, unverified users'),
  ('RENT_BUDDY_ADMIN_ONLY_MODE',         FALSE, 'Admin-only mode: only users with admin role can access Rent a Buddy'),
  ('RENT_BUDDY_BETA_ONLY_MODE',          FALSE, 'Beta-only mode: only users with active beta access can use Rent a Buddy'),
  ('RENT_BUDDY_NIGHTLIFE_ENABLED',       FALSE, 'Enable nightlife category bookings'),
  ('RENT_BUDDY_GROUP_BOOKINGS_ENABLED',  FALSE, 'Enable group bookings (group_size > 4)'),
  ('RENT_BUDDY_CASH_BALANCE_ENABLED',    FALSE, 'Enable deposit+cash payment mode globally'),
  ('RENT_BUDDY_PACKAGES_ENABLED',        FALSE, 'Enable pre-built packages in booking flow'),
  ('RENT_BUDDY_OFFERS_ENABLED',          FALSE, 'Enable buddy offers/bidding system'),
  ('RENT_BUDDY_DELAYED_POSTING_REQUIRED',FALSE, 'Require delayed posting for all location-tagged content during bookings')
ON CONFLICT (flag) DO NOTHING;

-- ======= PART: 0048_rent_buddy_marketplace =======

-- Migration 0048: Rent a Buddy — Marketplace Layer
-- New tables: match_preferences, search_events, match_scores, requests, offers,
--             package_stops, booking_addons, tips, pricing_rules, fee_rules,
--             earnings_ledger, marketplace_analytics_events
-- Extends: rent_buddy_profiles, rent_buddy_availability, rent_buddy_waitlist,
--          rent_buddy_packages, rent_buddy_addons, rent_buddy_saved, rent_buddy_bookings
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout

-- ── Extend rent_buddy_profiles ────────────────────────────────────────────────

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS featured               BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS featured_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS city_ambassador        BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS city_ambassador_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS available_now          BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS available_now_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_approved         BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nightlife_approved     BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS arrival_approved       BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS female_only_service    BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS public_meetup_only     BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS energy_type            TEXT     CHECK (energy_type IN ('chill','social','adventurous','professional','flexible')),
  ADD COLUMN IF NOT EXISTS profile_views          INT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_appearances     INT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeat_client_count    INT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS city_ranking           INT,
  ADD COLUMN IF NOT EXISTS half_day_rate_usd      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS full_day_rate_usd      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS nightlife_rate_usd     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS arrival_rate_usd       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS deposit_percent        INT      NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS cash_balance_accepted  BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS disable_deposit_cash   BOOLEAN  NOT NULL DEFAULT FALSE;

-- ── Extend rent_buddy_availability ───────────────────────────────────────────

ALTER TABLE rent_buddy_availability
  ADD COLUMN IF NOT EXISTS weekly_blocks          JSONB    NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS one_time_blocks        JSONB    NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS vacation_dates         JSONB    NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS min_notice_hours       INT      NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS buffer_minutes         INT      NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS max_bookings_per_day   INT      NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS nightlife_available    BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS arrival_available      BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS group_available        BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_available       BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── Extend rent_buddy_waitlist ────────────────────────────────────────────────

ALTER TABLE rent_buddy_waitlist
  ADD COLUMN IF NOT EXISTS language               TEXT,
  ADD COLUMN IF NOT EXISTS budget_max_usd         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS desired_date           DATE,
  ADD COLUMN IF NOT EXISTS desired_time           TIME,
  ADD COLUMN IF NOT EXISTS notes                  TEXT,
  ADD COLUMN IF NOT EXISTS expires_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status                 TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','matched','expired','cancelled')),
  ADD COLUMN IF NOT EXISTS notified_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_size             INT NOT NULL DEFAULT 1;

-- ── Extend rent_buddy_saved ───────────────────────────────────────────────────

ALTER TABLE rent_buddy_saved
  ADD COLUMN IF NOT EXISTS notes                  TEXT,
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── Extend rent_buddy_bookings ────────────────────────────────────────────────

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS offer_id               UUID,
  ADD COLUMN IF NOT EXISTS request_id             UUID,
  ADD COLUMN IF NOT EXISTS is_group_booking       BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS group_lead_id          UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS pricing_type           TEXT NOT NULL DEFAULT 'hourly'
    CHECK (pricing_type IN ('hourly','half_day','full_day','nightlife_block','arrival','package','custom')),
  ADD COLUMN IF NOT EXISTS deposit_rule_applied   TEXT,
  ADD COLUMN IF NOT EXISTS deposit_percent        INT,
  ADD COLUMN IF NOT EXISTS deposit_reason         TEXT,
  ADD COLUMN IF NOT EXISTS addons_total_usd       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_usd                NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS expires_at             TIMESTAMPTZ;

-- ── Extend rent_buddy_packages ────────────────────────────────────────────────

ALTER TABLE rent_buddy_packages
  ADD COLUMN IF NOT EXISTS city                   TEXT,
  ADD COLUMN IF NOT EXISTS base_price             NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS deposit_required       BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS deposit_percent        INT      NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS payment_modes_allowed  TEXT[]   NOT NULL DEFAULT '{full_in_app}',
  ADD COLUMN IF NOT EXISTS included_stops         JSONB    NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS included_services      TEXT[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS admin_review_status    TEXT     NOT NULL DEFAULT 'pending'
    CHECK (admin_review_status IN ('pending','approved','disabled')),
  ADD COLUMN IF NOT EXISTS admin_reviewed_by      UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS admin_reviewed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS addon_ids              UUID[]   NOT NULL DEFAULT '{}';

-- ── Extend rent_buddy_addons ──────────────────────────────────────────────────

ALTER TABLE rent_buddy_addons
  ADD COLUMN IF NOT EXISTS category               TEXT,
  ADD COLUMN IF NOT EXISTS requires_admin_approval BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_approved         BOOLEAN NOT NULL DEFAULT TRUE;

-- ── rent_buddy_match_preferences ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_match_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  need            TEXT,    -- 'city_guide'|'language_help'|'nightlife'|'content'|'arrival'|'group'|'custom'
  vibe            TEXT,    -- 'chill'|'social'|'adventurous'|'professional'|'flexible'
  energy          TEXT,    -- 'low'|'medium'|'high'
  language        TEXT,
  budget_min_usd  NUMERIC(10,2),
  budget_max_usd  NUMERIC(10,2),
  booking_length  TEXT,    -- 'under_2h'|'half_day'|'full_day'|'multi_day'
  safety_prefs    JSONB    NOT NULL DEFAULT '{}',
  group_size      INT      NOT NULL DEFAULT 1,
  female_only     BOOLEAN  NOT NULL DEFAULT FALSE,
  public_only     BOOLEAN  NOT NULL DEFAULT FALSE,
  raw_answers     JSONB    NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE rent_buddy_match_preferences ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_match_preferences' AND policyname='rb_match_prefs_own') THEN
    CREATE POLICY rb_match_prefs_own ON rent_buddy_match_preferences FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_match_preferences' AND policyname='rb_match_prefs_svc') THEN
    CREATE POLICY rb_match_prefs_svc ON rent_buddy_match_preferences FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── rent_buddy_search_events ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_search_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  city            TEXT,
  category        TEXT,
  filters         JSONB    NOT NULL DEFAULT '{}',
  result_count    INT      NOT NULL DEFAULT 0,
  session_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_search_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_search_events' AND policyname='rb_search_evt_svc') THEN
    CREATE POLICY rb_search_evt_svc ON rent_buddy_search_events FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_search_evt_user_idx ON rent_buddy_search_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rb_search_evt_city_idx ON rent_buddy_search_events(city, created_at DESC);

-- ── rent_buddy_match_scores ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_match_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  score           INT  NOT NULL,  -- 0–100
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  inputs          JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE rent_buddy_match_scores ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_match_scores' AND policyname='rb_match_scores_own') THEN
    CREATE POLICY rb_match_scores_own ON rent_buddy_match_scores FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_match_scores' AND policyname='rb_match_scores_svc') THEN
    CREATE POLICY rb_match_scores_svc ON rent_buddy_match_scores FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_match_scores_user_buddy ON rent_buddy_match_scores(user_id, buddy_id);
CREATE INDEX IF NOT EXISTS rb_match_scores_expiry     ON rent_buddy_match_scores(expires_at);

-- ── rent_buddy_requests ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  traveler_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city                TEXT NOT NULL,
  category            TEXT NOT NULL,
  desired_date        DATE,
  desired_time        TIME,
  duration_minutes    INT  NOT NULL DEFAULT 120,
  group_size          INT  NOT NULL DEFAULT 1,
  budget_min_usd      NUMERIC(10,2),
  budget_max_usd      NUMERIC(10,2),
  language_needed     TEXT,
  energy_type         TEXT,
  safety_prefs        JSONB NOT NULL DEFAULT '{}',
  payment_mode_pref   TEXT CHECK (payment_mode_pref IN ('full_in_app','deposit_plus_cash','any')),
  notes               TEXT,
  policy_flag         BOOLEAN NOT NULL DEFAULT FALSE,
  policy_flag_reason  TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','matched','expired','cancelled','closed')),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  notified_buddy_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_requests' AND policyname='rb_requests_own') THEN
    CREATE POLICY rb_requests_own ON rent_buddy_requests FOR ALL USING (auth.uid() = traveler_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_requests' AND policyname='rb_requests_read') THEN
    CREATE POLICY rb_requests_read ON rent_buddy_requests FOR SELECT USING (status = 'open');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_requests' AND policyname='rb_requests_svc') THEN
    CREATE POLICY rb_requests_svc ON rent_buddy_requests FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_requests_traveler_idx ON rent_buddy_requests(traveler_id);
CREATE INDEX IF NOT EXISTS rb_requests_city_cat_idx ON rent_buddy_requests(city, category, status);
CREATE INDEX IF NOT EXISTS rb_requests_expiry_idx   ON rent_buddy_requests(expires_at) WHERE status = 'open';

-- ── rent_buddy_offers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID NOT NULL REFERENCES rent_buddy_requests(id) ON DELETE CASCADE,
  buddy_profile_id    UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  buddy_user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  proposed_price_usd  NUMERIC(10,2) NOT NULL,
  deposit_amount_usd  NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_balance_usd    NUMERIC(10,2) NOT NULL DEFAULT 0,
  proposed_start      TIMESTAMPTZ,
  proposed_end        TIMESTAMPTZ,
  meetup_location     TEXT,
  message             TEXT,
  included_services   TEXT[] NOT NULL DEFAULT '{}',
  addons_offered      JSONB  NOT NULL DEFAULT '[]',
  payment_mode        TEXT NOT NULL DEFAULT 'full_in_app'
    CHECK (payment_mode IN ('full_in_app','deposit_plus_cash')),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours'),
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','expired','withdrawn')),
  accepted_booking_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_offers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_offers' AND policyname='rb_offers_buddy') THEN
    CREATE POLICY rb_offers_buddy ON rent_buddy_offers FOR ALL USING (auth.uid() = buddy_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_offers' AND policyname='rb_offers_traveler') THEN
    CREATE POLICY rb_offers_traveler ON rent_buddy_offers FOR SELECT
      USING (request_id IN (SELECT id FROM rent_buddy_requests WHERE traveler_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_offers' AND policyname='rb_offers_svc') THEN
    CREATE POLICY rb_offers_svc ON rent_buddy_offers FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_offers_request_idx ON rent_buddy_offers(request_id);
CREATE INDEX IF NOT EXISTS rb_offers_buddy_idx   ON rent_buddy_offers(buddy_profile_id);
CREATE INDEX IF NOT EXISTS rb_offers_expiry_idx  ON rent_buddy_offers(expires_at) WHERE status = 'pending';

-- ── rent_buddy_package_stops ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_package_stops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL REFERENCES rent_buddy_packages(id) ON DELETE CASCADE,
  sort_order      INT  NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  description     TEXT,
  location_hint   TEXT,
  duration_minutes INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_package_stops ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_package_stops' AND policyname='rb_pkg_stops_read') THEN
    CREATE POLICY rb_pkg_stops_read ON rent_buddy_package_stops FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_package_stops' AND policyname='rb_pkg_stops_own') THEN
    CREATE POLICY rb_pkg_stops_own ON rent_buddy_package_stops FOR ALL
      USING (package_id IN (
        SELECT p.id FROM rent_buddy_packages p
        JOIN rent_buddy_profiles bp ON bp.id = p.buddy_id
        WHERE bp.user_id = auth.uid()
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_package_stops' AND policyname='rb_pkg_stops_svc') THEN
    CREATE POLICY rb_pkg_stops_svc ON rent_buddy_package_stops FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_pkg_stops_pkg_idx ON rent_buddy_package_stops(package_id, sort_order);

-- ── rent_buddy_booking_addons ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_booking_addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  addon_id        UUID REFERENCES rent_buddy_addons(id),
  title           TEXT NOT NULL,
  price_usd       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_booking_addons ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_booking_addons' AND policyname='rb_bk_addons_parties') THEN
    CREATE POLICY rb_bk_addons_parties ON rent_buddy_booking_addons FOR SELECT
      USING (
        booking_id IN (
          SELECT id FROM rent_buddy_bookings
          WHERE traveler_id = auth.uid()
             OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_booking_addons' AND policyname='rb_bk_addons_svc') THEN
    CREATE POLICY rb_bk_addons_svc ON rent_buddy_booking_addons FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_bk_addons_booking_idx ON rent_buddy_booking_addons(booking_id);

-- ── rent_buddy_tips ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_tips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  traveler_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buddy_user_id   UUID NOT NULL REFERENCES profiles(id),
  amount_usd      NUMERIC(10,2) NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id)
);

ALTER TABLE rent_buddy_tips ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_tips' AND policyname='rb_tips_own') THEN
    CREATE POLICY rb_tips_own ON rent_buddy_tips FOR ALL USING (auth.uid() = traveler_id OR auth.uid() = buddy_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_tips' AND policyname='rb_tips_svc') THEN
    CREATE POLICY rb_tips_svc ON rent_buddy_tips FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_tips_booking_idx ON rent_buddy_tips(booking_id);
CREATE INDEX IF NOT EXISTS rb_tips_buddy_idx   ON rent_buddy_tips(buddy_user_id);

-- ── rent_buddy_pricing_rules ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_pricing_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city                TEXT,    -- NULL = global default
  category            TEXT,    -- NULL = all categories
  buddy_level         TEXT,    -- NULL = all levels
  pricing_type        TEXT NOT NULL DEFAULT 'hourly',
  suggested_min_usd   NUMERIC(10,2) NOT NULL,
  suggested_max_usd   NUMERIC(10,2) NOT NULL,
  notes               TEXT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_pricing_rules ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_pricing_rules' AND policyname='rb_pricing_read') THEN
    CREATE POLICY rb_pricing_read ON rent_buddy_pricing_rules FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_pricing_rules' AND policyname='rb_pricing_svc') THEN
    CREATE POLICY rb_pricing_svc ON rent_buddy_pricing_rules FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── rent_buddy_fee_rules ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_fee_rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_level               TEXT NOT NULL UNIQUE,
  platform_fee_percent      INT  NOT NULL,
  traveler_service_fee_usd  NUMERIC(10,2) NOT NULL DEFAULT 0,
  traveler_service_fee_pct  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_fee_rules ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_fee_rules' AND policyname='rb_fee_rules_read') THEN
    CREATE POLICY rb_fee_rules_read ON rent_buddy_fee_rules FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_fee_rules' AND policyname='rb_fee_rules_svc') THEN
    CREATE POLICY rb_fee_rules_svc ON rent_buddy_fee_rules FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Seed default fee rules
INSERT INTO rent_buddy_fee_rules (buddy_level, platform_fee_percent, traveler_service_fee_pct)
VALUES
  ('new',           25, 5),
  ('rising',        22, 5),
  ('pro',           15, 5),
  ('elite',         12, 5),
  ('city_ambassador',12, 5)
ON CONFLICT (buddy_level) DO NOTHING;

-- ── rent_buddy_earnings_ledger ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_earnings_ledger (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                  UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  buddy_user_id               UUID NOT NULL REFERENCES profiles(id),
  traveler_id                 UUID NOT NULL REFERENCES profiles(id),
  pricing_type                TEXT,
  total_booking_usd           NUMERIC(10,2) NOT NULL DEFAULT 0,
  addons_usd                  NUMERIC(10,2) NOT NULL DEFAULT 0,
  tip_usd                     NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee_percent        INT,
  platform_fee_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  traveler_service_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  buddy_gross_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  buddy_net_estimated_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  deposit_amount              NUMERIC(10,2) NOT NULL DEFAULT 0,
  in_app_amount_collected     NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_balance_due            NUMERIC(10,2) NOT NULL DEFAULT 0,
  cash_balance_confirmed      BOOLEAN NOT NULL DEFAULT FALSE,
  is_estimated                BOOLEAN NOT NULL DEFAULT TRUE,
  note                        TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id)
);

ALTER TABLE rent_buddy_earnings_ledger ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_earnings_ledger' AND policyname='rb_ledger_buddy') THEN
    CREATE POLICY rb_ledger_buddy ON rent_buddy_earnings_ledger FOR SELECT USING (auth.uid() = buddy_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_earnings_ledger' AND policyname='rb_ledger_svc') THEN
    CREATE POLICY rb_ledger_svc ON rent_buddy_earnings_ledger FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_ledger_buddy_idx   ON rent_buddy_earnings_ledger(buddy_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rb_ledger_booking_idx ON rent_buddy_earnings_ledger(booking_id);

-- ── rent_buddy_marketplace_analytics_events ───────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_marketplace_analytics_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT NOT NULL
    CHECK (event_type IN (
      'search','view','request','booking','completion','cancellation',
      'dispute','no_show','offer_sent','offer_accepted','offer_declined',
      'waitlist_join','waitlist_match','tip_sent','addon_attached'
    )),
  user_id         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  buddy_id        UUID REFERENCES rent_buddy_profiles(id) ON DELETE SET NULL,
  city            TEXT,
  category        TEXT,
  amount_usd      NUMERIC(10,2),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_marketplace_analytics_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_marketplace_analytics_events' AND policyname='rb_analytics_svc') THEN
    CREATE POLICY rb_analytics_svc ON rent_buddy_marketplace_analytics_events FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rb_analytics_type_idx    ON rent_buddy_marketplace_analytics_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS rb_analytics_city_idx    ON rent_buddy_marketplace_analytics_events(city, created_at DESC);
CREATE INDEX IF NOT EXISTS rb_analytics_buddy_idx   ON rent_buddy_marketplace_analytics_events(buddy_id, created_at DESC);

-- ── city_payment_restrictions (per-city/category deposit_plus_cash disable) ──

CREATE TABLE IF NOT EXISTS rent_buddy_city_restrictions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city                        TEXT,
  category                    TEXT,
  disable_deposit_cash        BOOLEAN NOT NULL DEFAULT FALSE,
  require_public_meetup       BOOLEAN NOT NULL DEFAULT FALSE,
  require_full_in_app         BOOLEAN NOT NULL DEFAULT FALSE,
  reason                      TEXT,
  created_by                  UUID REFERENCES profiles(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (city, category)
);

ALTER TABLE rent_buddy_city_restrictions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_city_restrictions' AND policyname='rb_city_restrict_read') THEN
    CREATE POLICY rb_city_restrict_read ON rent_buddy_city_restrictions FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rent_buddy_city_restrictions' AND policyname='rb_city_restrict_svc') THEN
    CREATE POLICY rb_city_restrict_svc ON rent_buddy_city_restrictions FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('rent_buddy_marketplace_enabled', FALSE, 'Rent a Buddy — marketplace matching and discovery sections'),
  ('rent_buddy_available_now_enabled', FALSE, 'Rent a Buddy — Available Now real-time section'),
  ('rent_buddy_requests_enabled', FALSE, 'Rent a Buddy — Request a Buddy open-request flow'),
  ('rent_buddy_packages_v2_enabled', FALSE, 'Rent a Buddy — enhanced packages with stops and admin review'),
  ('rent_buddy_tips_enabled', FALSE, 'Rent a Buddy — post-completion tip flow'),
  ('rent_buddy_earnings_ledger_enabled', FALSE, 'Rent a Buddy — per-booking earnings ledger for Buddies')
ON CONFLICT (flag) DO NOTHING;

-- ======= PART: 0051_rent_buddy_compliance =======

-- Migration 0051: Rent a Buddy compliance, launch controls, and legal hardening
-- Steps: launch controls, admin access logs, tag consents, risk review status,
--        training checklist, support reports, admin response templates.

-- ── rent_buddy_launch_controls ────────────────────────────────────────────────
-- Per country/city/category launch gates. MVP defaults: conservative.

CREATE TABLE IF NOT EXISTS rent_buddy_launch_controls (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code               TEXT,          -- NULL = global rule
  city                       TEXT,          -- NULL = all cities in country
  category                   TEXT,          -- NULL = all categories
  enabled                    BOOLEAN NOT NULL DEFAULT FALSE,
  waitlist_only              BOOLEAN NOT NULL DEFAULT FALSE,  -- allow waitlist but block paid booking
  min_age                    INT     NOT NULL DEFAULT 18,
  nightlife_min_age          INT     NOT NULL DEFAULT 21,
  require_id_verification    BOOLEAN NOT NULL DEFAULT TRUE,
  require_phone_verification BOOLEAN NOT NULL DEFAULT TRUE,
  full_payment_required      BOOLEAN NOT NULL DEFAULT FALSE,
  min_deposit_pct            INT     NOT NULL DEFAULT 30,
  notes                      TEXT,
  created_by                 UUID REFERENCES profiles(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (country_code, city, category)
);

ALTER TABLE rent_buddy_launch_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_lc_read ON rent_buddy_launch_controls FOR SELECT USING (TRUE);
CREATE POLICY rb_lc_svc  ON rent_buddy_launch_controls FOR ALL   USING (auth.role() = 'service_role');

-- Seed MVP conservative defaults
INSERT INTO rent_buddy_launch_controls (country_code, city, category, enabled, waitlist_only, notes)
VALUES
  (NULL, NULL, 'city',       TRUE,  FALSE, 'City Explorer — globally enabled at launch'),
  (NULL, NULL, 'language',   TRUE,  FALSE, 'Language Bridge — globally enabled at launch'),
  (NULL, NULL, 'arrival',    TRUE,  FALSE, 'Airport Arrival — globally enabled at launch'),
  (NULL, NULL, 'content',    TRUE,  FALSE, 'Content Creator — globally enabled at launch'),
  (NULL, NULL, 'shopping',   TRUE,  FALSE, 'Shopping Helper — globally enabled at launch'),
  (NULL, NULL, 'food',       TRUE,  FALSE, 'Food & Markets — globally enabled at launch'),
  (NULL, NULL, 'culture',    TRUE,  FALSE, 'Culture & Arts — globally enabled at launch'),
  (NULL, NULL, 'wellness',   TRUE,  FALSE, 'Wellness — globally enabled at launch'),
  (NULL, NULL, 'nightlife',  FALSE, TRUE,  'Nightlife — waitlist only; manual admin sign-off required'),
  (NULL, NULL, 'group',      FALSE, FALSE, 'Group Buddy — disabled pending pilot'),
  (NULL, NULL, 'concierge',  FALSE, FALSE, 'Concierge — disabled pending pilot'),
  (NULL, NULL, 'adventure',  TRUE,  FALSE, 'Adventure — enabled at launch'),
  (NULL, NULL, 'other',      TRUE,  FALSE, 'Custom / Other — enabled at launch')
ON CONFLICT (country_code, city, category) DO NOTHING;

CREATE INDEX IF NOT EXISTS rb_lc_country_idx  ON rent_buddy_launch_controls (country_code);
CREATE INDEX IF NOT EXISTS rb_lc_city_idx     ON rent_buddy_launch_controls (city);
CREATE INDEX IF NOT EXISTS rb_lc_category_idx ON rent_buddy_launch_controls (category);

-- ── rent_buddy_admin_access_logs ──────────────────────────────────────────────
-- Immutable audit log: written whenever admin reads sensitive booking/user context.

CREATE TABLE IF NOT EXISTS rent_buddy_admin_access_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID NOT NULL REFERENCES profiles(id),
  resource     TEXT NOT NULL,   -- 'booking_location','booking_id_status','safety_events','chat','user_id_status'
  resource_id  TEXT,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_access_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_alog_svc ON rent_buddy_admin_access_logs FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_alog_admin_idx ON rent_buddy_admin_access_logs (admin_id);
CREATE INDEX IF NOT EXISTS rb_alog_res_idx   ON rent_buddy_admin_access_logs (resource, resource_id);

-- ── risk_review_status on rent_buddy_profiles ─────────────────────────────────

DO $$ BEGIN
  CREATE TYPE rent_buddy_risk_status AS ENUM ('normal','watch','limited','under_review','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS risk_review_status rent_buddy_risk_status NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS risk_review_note    TEXT,
  ADD COLUMN IF NOT EXISTS risk_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nightlife_admin_approved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS training_completed  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS id_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS age_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS date_of_birth       DATE;

-- ── rent_buddy_tag_consents ───────────────────────────────────────────────────
-- Mutual consent before either party publicly tags the other in a post.

DO $$ BEGIN
  CREATE TYPE rb_tag_consent_status AS ENUM ('pending','approved','declined','removed','auto_removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rent_buddy_tag_consents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requester_id   UUID NOT NULL REFERENCES profiles(id),  -- party requesting to tag
  target_id      UUID NOT NULL REFERENCES profiles(id),  -- party being tagged
  post_id        UUID,                                    -- optional: the post being tagged in
  consent_status rb_tag_consent_status NOT NULL DEFAULT 'pending',
  decline_reason TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, requester_id, target_id)
);

ALTER TABLE rent_buddy_tag_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_tc_parties ON rent_buddy_tag_consents FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = target_id);
CREATE POLICY rb_tc_insert  ON rent_buddy_tag_consents FOR INSERT WITH CHECK (auth.uid() = requester_id);
CREATE POLICY rb_tc_update  ON rent_buddy_tag_consents FOR UPDATE
  USING (auth.uid() = target_id);  -- only target can approve/decline
CREATE POLICY rb_tc_svc     ON rent_buddy_tag_consents FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_tc_booking_idx   ON rent_buddy_tag_consents (booking_id);
CREATE INDEX IF NOT EXISTS rb_tc_target_idx    ON rent_buddy_tag_consents (target_id, consent_status);

-- ── rent_buddy_training_checklist ─────────────────────────────────────────────
-- Per-application training completion. All 10 items must be checked before approval.

CREATE TABLE IF NOT EXISTS rent_buddy_training_checklist (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES rent_buddy_applications(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id),
  item_key       TEXT NOT NULL,   -- e.g. 'safety_policy','emergency_protocol','no_adult_services', ...
  completed      BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, item_key)
);

ALTER TABLE rent_buddy_training_checklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_train_own ON rent_buddy_training_checklist FOR ALL USING (auth.uid() = user_id);
CREATE POLICY rb_train_svc ON rent_buddy_training_checklist FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_train_app_idx ON rent_buddy_training_checklist (application_id);

-- ── rent_buddy_support_reports ────────────────────────────────────────────────
-- Structured support categories per booking.

DO $$ BEGIN
  CREATE TYPE rb_support_category AS ENUM (
    'buddy_no_show','traveler_no_show','cash_dispute','harassment',
    'adult_service_violation','off_app_payment','route_changed',
    'venue_scam','refund_request','fake_profile','emergency','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rb_support_status AS ENUM ('open','in_review','resolved','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rent_buddy_support_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES rent_buddy_bookings(id),
  reporter_id   UUID NOT NULL REFERENCES profiles(id),
  category      rb_support_category NOT NULL,
  details       TEXT,
  status        rb_support_status NOT NULL DEFAULT 'open',
  admin_notes   TEXT,
  template_id   UUID,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_support_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_sr_own ON rent_buddy_support_reports FOR SELECT USING (auth.uid() = reporter_id);
CREATE POLICY rb_sr_ins ON rent_buddy_support_reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY rb_sr_svc ON rent_buddy_support_reports FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_sr_booking_idx ON rent_buddy_support_reports (booking_id);
CREATE INDEX IF NOT EXISTS rb_sr_status_idx  ON rent_buddy_support_reports (status);

-- ── rent_buddy_admin_response_templates ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_admin_response_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT NOT NULL,   -- matches rb_support_category values
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_response_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_art_read ON rent_buddy_admin_response_templates FOR SELECT USING (auth.role() = 'service_role');
CREATE POLICY rb_art_svc  ON rent_buddy_admin_response_templates FOR ALL  USING (auth.role() = 'service_role');

-- Seed default templates
INSERT INTO rent_buddy_admin_response_templates (category, title, body) VALUES
  ('buddy_no_show',       'Buddy No-Show — Refund Initiated',
   'We are sorry your Buddy did not show up. A full refund has been initiated and will appear within 3–5 business days. We have noted this on the Buddy''s record.'),
  ('traveler_no_show',    'Traveler No-Show — Deposit Forfeited',
   'Per our cancellation policy, no-show travelers forfeit their deposit. Your Buddy has been compensated for their time.'),
  ('cash_dispute',        'Cash Balance Dispute — Under Review',
   'We have opened a review of the cash balance disagreement. Both parties will be contacted within 48 hours. Please do not meet outside the app while the review is open.'),
  ('harassment',          'Harassment Report — Urgent Review',
   'We take harassment reports extremely seriously. Your report has been escalated to our Trust & Safety team. You will hear from us within 24 hours.'),
  ('adult_service_violation', 'Adult Service Violation — Investigation',
   'This report has been flagged for immediate review. Any violation of our non-adult-service policy results in permanent removal.'),
  ('off_app_payment',     'Off-App Payment Attempt',
   'Requesting payment outside the app violates our terms. We are investigating and have restricted the flagged account pending review.'),
  ('venue_scam',          'Venue Scam Report',
   'We have logged your report. We investigate repeated venue-related complaints and will take action if a pattern is identified.'),
  ('refund_request',      'Refund Request Received',
   'Your refund request is under review. Payment disputes must be filed within 72 hours of booking completion.'),
  ('emergency',           'Emergency Report — Immediate Escalation',
   'Your safety is our priority. If you are in immediate danger, please contact local emergency services (call 112 or 911). Our team has been notified and will contact you within the hour.'),
  ('other',               'Support Request Received',
   'Thank you for reaching out. A member of our support team will review your request and respond within 2 business days.')
ON CONFLICT DO NOTHING;

-- ── venue_scam safety event type (extend existing enum if not already there) ──

DO $$ BEGIN
  ALTER TYPE rent_buddy_safety_event_type ADD VALUE IF NOT EXISTS 'venue_scam_complaint';
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_safety_event_type ADD VALUE IF NOT EXISTS 'nightlife_unsafe_end';
EXCEPTION WHEN others THEN NULL; END $$;

-- ── Indexes for abuse-detection pattern queries ────────────────────────────────

CREATE INDEX IF NOT EXISTS rb_safety_evt_actor_idx  ON rent_buddy_safety_events (actor_user_id, event_type);
CREATE INDEX IF NOT EXISTS rb_safety_evt_target_idx ON rent_buddy_safety_events (target_user_id, event_type);
CREATE INDEX IF NOT EXISTS rb_disputes_raised_idx   ON rent_buddy_disputes (raised_by, reason);
CREATE INDEX IF NOT EXISTS rb_profiles_risk_idx     ON rent_buddy_profiles (risk_review_status);

-- ======= PART: 0107_rent_buddy_admin_actions =======

-- 0047 already creates policy rb_admin_actions_svc; drop so 0107's re-create succeeds.
DROP POLICY IF EXISTS rb_admin_actions_svc ON rent_buddy_admin_actions;

-- Migration 0107: rent_buddy_admin_actions — admin audit log table
-- This table is referenced by rentABuddy.ts and rentABuddyMarketplace.ts
-- admin routes (feature, unfeature, suspend, approve, etc.) but was absent
-- from prior migrations (0047–0051).  Applied here to close the gap.
--
-- Columns:
--   notes   TEXT  — human-readable note written by route handlers
--   details JSONB — structured metadata defined in database.types.ts
-- Both are kept so the existing route inserts (which use `notes`) and the
-- type definitions (which reference `details`) remain consistent.

CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,   -- 'application'|'buddy'|'profile'|'package'|'user'
  target_id   TEXT NOT NULL,   -- UUID-shaped string of the affected entity
  action      TEXT NOT NULL,   -- free-form label e.g. 'approved', 'suspended', 'featured'
  notes       TEXT,            -- human-readable note (used by route inserts)
  details     JSONB,           -- structured metadata (defined in database.types.ts)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;

-- Service role can read and write; no direct user access
CREATE POLICY rb_admin_actions_svc ON rent_buddy_admin_actions
  FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_admin_actions_admin_idx
  ON rent_buddy_admin_actions (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rb_admin_actions_target_idx
  ON rent_buddy_admin_actions (target_type, target_id);

-- ======= PART: 0108_rent_buddy_spec_tables (fixed) =======

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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bae_buddy_date_unique') THEN
    ALTER TABLE buddy_availability_exceptions
      ADD CONSTRAINT bae_buddy_date_unique UNIQUE (buddy_id, exception_date);
  END IF;
END $$;

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

-- ======= PART: 0109_rent_buddy_missing_enums =======

-- Migration 0109: Add missing spec enum types for Rent-a-Buddy
-- Adds: rent_buddy_verification_status, rent_buddy_change_request_status,
--       rent_buddy_payment_status (with not_required default for pre-integration)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_verification_status') THEN
    CREATE TYPE rent_buddy_verification_status AS ENUM (
      'unverified',
      'id_submitted',
      'in_review',
      'verified',
      'rejected'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_change_request_status') THEN
    CREATE TYPE rent_buddy_change_request_status AS ENUM (
      'pending',
      'approved',
      'declined',
      'expired'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_payment_status') THEN
    CREATE TYPE rent_buddy_payment_status AS ENUM (
      'not_required',   -- placeholder default until payment provider integration is live
      'pending',
      'authorized',
      'captured',
      'partial',
      'refunded',
      'failed'
    );
  END IF;
END $$;

-- Add verification_status column to rent_buddy_profiles if it doesn't exist yet.
-- Existing 'verified BOOLEAN' column is preserved; this adds a richer status field.
ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS verification_status rent_buddy_verification_status
    NOT NULL DEFAULT 'unverified';

-- Keep verification_status in sync with existing verified boolean via trigger.
CREATE OR REPLACE FUNCTION sync_buddy_verification_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verified = TRUE AND NEW.verification_status = 'unverified' THEN
    NEW.verification_status := 'verified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_buddy_verification_status ON rent_buddy_profiles;
CREATE TRIGGER trg_sync_buddy_verification_status
  BEFORE INSERT OR UPDATE OF verified ON rent_buddy_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_buddy_verification_status();

-- Backfill verification_status for already-verified rows
UPDATE rent_buddy_profiles
  SET verification_status = 'verified'
  WHERE verified = TRUE AND verification_status = 'unverified';

-- Add payment_status to rent_buddy_bookings (defaults to not_required until provider is live)
ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS payment_status rent_buddy_payment_status
    NOT NULL DEFAULT 'not_required';

-- ======= PART: 0110_rent_buddy_payouts =======

-- Migration 0110: rent_buddy_payouts table for payout hold/release lifecycle
-- Payouts represent amounts owed to buddies after booking completion.

CREATE TABLE IF NOT EXISTS rent_buddy_payouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  buddy_id          UUID NOT NULL REFERENCES rent_buddy_profiles(id),
  amount_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'on_hold' | 'approved' | 'released' | 'failed'
  hold_reason       TEXT,
  released_by       UUID REFERENCES profiles(id),
  held_by           UUID REFERENCES profiles(id),
  held_at           TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_payout_svc ON rent_buddy_payouts
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY rb_payout_buddy_read ON rent_buddy_payouts FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS rb_payouts_booking_idx ON rent_buddy_payouts(booking_id);
CREATE INDEX IF NOT EXISTS rb_payouts_buddy_idx   ON rent_buddy_payouts(buddy_id);
CREATE INDEX IF NOT EXISTS rb_payouts_status_idx  ON rent_buddy_payouts(status);

-- ======= PART: 0111_rent_buddy_onboarding_ack =======

-- Migration 0111: Rent a Buddy — onboarding acknowledgment timestamps
--
-- Adds two acknowledgment columns to rent_buddy_profiles:
--   safety_acknowledged_at     — buddy confirmed they read the safety policy
--   boundaries_acknowledged_at — buddy confirmed the conduct/boundaries policy
--
-- Both are checked by the POST /me/profile/submit gate (returns 422 if null).

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS safety_acknowledged_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS boundaries_acknowledged_at TIMESTAMPTZ;

-- ======= PART: 0112_rent_buddy_lifecycle =======

-- Migration 0112: Rent a Buddy — booking lifecycle state machine hardening
-- Adds missing status enum values, expiry tracking, and decline/dispute window columns.

-- ── New booking status values ───────────────────────────────────────────────
-- declined: buddy explicitly declined the request (not the same as cancelled)
-- expired: request was not answered before expires_at
-- cancelled_by_traveler / cancelled_by_buddy: specific cancellation actors
-- completed_pending_traveler_confirmation: buddy marked done; traveler has dispute window
-- scheduled: spec alias for confirmed (added for contract compatibility)

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'declined';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'expired';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_traveler';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_buddy';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'completed_pending_traveler_confirmation';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE rent_buddy_booking_status ADD VALUE 'scheduled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Lifecycle tracking columns ──────────────────────────────────────────────

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS expires_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason             TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason        TEXT,
  ADD COLUMN IF NOT EXISTS dispute_window_expires_at  TIMESTAMPTZ;

-- Backfill expires_at for existing pending requests (48h from creation)
UPDATE rent_buddy_bookings
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE status = 'pending'
    AND expires_at IS NULL;

-- ── Indexes for the expiry sweeper ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS rbb_pending_expires_idx ON rent_buddy_bookings (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS rbb_pending_confirm_expires_idx ON rent_buddy_bookings (dispute_window_expires_at)
  WHERE status = 'completed_pending_traveler_confirmation';

-- ======= PART: 0113_rent_buddy_lifecycle_fixes =======

-- Migration 0113: Rent-a-Buddy lifecycle fixes
-- Adds: new checkin_type enum values, no_show_pending booking status,
--       no_show_grace_expires_at column, and booking change-request table

-- ── 1. New checkin_type values ────────────────────────────────────────────────
-- Existing: arrival, comfort_30min, check_ok, uncomfortable, end_early,
--           contact_support, start_safe_return, emergency_phrase
-- New values needed by lifecycle check-in and no-show endpoints:

ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'arrived';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'started';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'could_not_find';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'no_show';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'unsafe';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'missed';

-- ── 2. requested booking status (initial state for new booking requests) ────
-- Task spec requires status = requested on creation (not pending).
-- pending is kept for backward compat with any existing rows.

ALTER TYPE rent_buddy_booking_status ADD VALUE IF NOT EXISTS 'requested';

-- ── 3. no_show_pending booking status ────────────────────────────────────────
-- Booking enters no_show_pending when a party reports the other did not appear.
-- The expiry sweeper escalates to 'disputed' after no_show_grace_expires_at.

ALTER TYPE rent_buddy_booking_status ADD VALUE IF NOT EXISTS 'no_show_pending';

-- ── 3. no_show_grace_expires_at column ────────────────────────────────────────
-- Records when the grace period for a no-show response expires.
-- Set by the no-show reporting endpoint; read by the expiry sweeper.

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS no_show_grace_expires_at TIMESTAMPTZ;

-- ── 4. buddy_booking_change_requests — time/service/price change requests ─────
-- Distinct from rent_buddy_route_change_requests (which tracks GPS route stops).
-- This table tracks proposed changes to booking date, start time, duration,
-- service type, or agreed price before the session starts.
--
-- Either party can raise a change request; the other party accepts or declines.
-- Only accepted requests mutate the booking row.

CREATE TABLE IF NOT EXISTS buddy_booking_change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by     UUID NOT NULL REFERENCES profiles(id),
  change_field     TEXT NOT NULL,   -- 'date' | 'start_time' | 'duration_h' | 'service' | 'price_usd'
  current_value    JSONB NOT NULL DEFAULT '{}',
  proposed_value   JSONB NOT NULL DEFAULT '{}',
  reason           TEXT,
  status           rent_buddy_change_request_status NOT NULL DEFAULT 'pending',
  responded_by     UUID REFERENCES profiles(id),
  response_note    TEXT,
  responded_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup of pending change requests for a booking
CREATE INDEX IF NOT EXISTS idx_buddy_bk_change_requests_booking
  ON buddy_booking_change_requests (booking_id, status);

-- RLS: parties to the booking can read; service role has full access
ALTER TABLE buddy_booking_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY bk_chg_req_read ON buddy_booking_change_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    OR booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
    )
  );

CREATE POLICY bk_chg_req_svc ON buddy_booking_change_requests FOR ALL
  USING (auth.role() = 'service_role');

-- ======= PART: 0133_rent_buddy_availability_alignment =======

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
-- ── PART N: Route-alignment columns not present in any prior migration ─────────
-- BUDDY_PUBLIC_COLUMNS in rentABuddy.ts selects these; PostgREST fails the whole
-- select if any column is unknown, so they must exist.

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS completed_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancel_count     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_show_count    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS favorites_count  INT NOT NULL DEFAULT 0,
  -- selected by the request fan-out notifier (best-effort push notifications)
  ADD COLUMN IF NOT EXISTS expo_push_token  TEXT;

-- rent_buddy_admin_actions: 0047 creates it first, so 0107's IF NOT EXISTS
-- no-ops. Align to the 0107 shape the routes/types use (nullable admin_id,
-- TEXT target_id, details JSONB alongside notes).
ALTER TABLE rent_buddy_admin_actions
  ALTER COLUMN admin_id DROP NOT NULL,
  ALTER COLUMN target_id TYPE TEXT,
  ADD COLUMN IF NOT EXISTS details JSONB;

-- Picked-city coordinates (0130_rent_buddy_place_coords): routes write lat/lng
-- unconditionally on waitlist joins and open requests.
ALTER TABLE rent_buddy_waitlist
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE IF EXISTS rent_buddy_requests
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
