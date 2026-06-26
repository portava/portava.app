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
