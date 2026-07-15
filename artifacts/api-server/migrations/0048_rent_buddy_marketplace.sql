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
