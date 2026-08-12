-- 0090_rent_buddy_rollout_tables.sql
-- Captures the rent-buddy rollout tables that were previously applied inline
-- (no SQL file existed in src/migrations/).  Safe to re-run: every statement
-- uses IF NOT EXISTS, ON CONFLICT, or DROP POLICY IF EXISTS guards.
--
-- Tables created:
--   rent_buddy_city_rollouts     — per-city launch status; queried by checkRentBuddyAccess
--   rent_buddy_beta_access       — per-user beta invitations
--   rent_buddy_launch_checklists — QA pass/fail gate before city goes public_mvp
--   rent_buddy_launch_audit_logs — append-only admin action log
--   rent_buddy_global_controls   — singleton kill-switch row (id = 1)
--
-- Without these tables every checkRentBuddyAccess call returns city_not_available
-- and the Rent a Buddy feature is invisible to all users.
--
-- Applied: 2026-07-03

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

DROP POLICY IF EXISTS rb_rollout_svc ON rent_buddy_city_rollouts;
CREATE POLICY rb_rollout_svc ON rent_buddy_city_rollouts FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS rb_rollout_public_read ON rent_buddy_city_rollouts;
CREATE POLICY rb_rollout_public_read ON rent_buddy_city_rollouts FOR SELECT USING (TRUE);

CREATE INDEX IF NOT EXISTS rb_city_rollouts_status_idx ON rent_buddy_city_rollouts(status);
CREATE INDEX IF NOT EXISTS rb_city_rollouts_city_idx   ON rent_buddy_city_rollouts(city);

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

DROP POLICY IF EXISTS rb_beta_own_read ON rent_buddy_beta_access;
CREATE POLICY rb_beta_own_read ON rent_buddy_beta_access FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS rb_beta_svc ON rent_buddy_beta_access;
CREATE POLICY rb_beta_svc ON rent_buddy_beta_access FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_beta_access_user_idx   ON rent_buddy_beta_access(user_id);
CREATE INDEX IF NOT EXISTS rb_beta_access_city_idx   ON rent_buddy_beta_access(city);
CREATE INDEX IF NOT EXISTS rb_beta_access_status_idx ON rent_buddy_beta_access(status);

-- ── rent_buddy_launch_checklists ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rent_buddy_launch_checklists (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_rollout_id       UUID NOT NULL REFERENCES rent_buddy_city_rollouts(id) ON DELETE CASCADE,
  checklist_status      rent_buddy_checklist_status NOT NULL DEFAULT 'pending',
  policy_scan_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  safety_flow_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  booking_flow_passed       BOOLEAN NOT NULL DEFAULT FALSE,
  telegraph_passed          BOOLEAN NOT NULL DEFAULT FALSE,
  trust_score_passed        BOOLEAN NOT NULL DEFAULT FALSE,
  payment_flow_passed       BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_passed         BOOLEAN NOT NULL DEFAULT FALSE,
  waitlist_flow_passed      BOOLEAN NOT NULL DEFAULT FALSE,
  buddy_application_passed  BOOLEAN NOT NULL DEFAULT FALSE,
  tested_by_admin_id    UUID REFERENCES profiles(id),
  tested_at             TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (city_rollout_id)
);

ALTER TABLE rent_buddy_launch_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rb_checklist_svc ON rent_buddy_launch_checklists;
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

DROP POLICY IF EXISTS rb_audit_svc ON rent_buddy_launch_audit_logs;
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

INSERT INTO rent_buddy_global_controls (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE rent_buddy_global_controls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rb_global_svc ON rent_buddy_global_controls;
CREATE POLICY rb_global_svc ON rent_buddy_global_controls FOR ALL USING (auth.role() = 'service_role');

-- ── Feature flags ─────────────────────────────────────────────────────────────

-- rent_buddy_enabled must be TRUE after a restore, regardless of what earlier
-- migrations seeded (e.g. 0050_rent_a_buddy.sql seeds it FALSE).
-- Use DO UPDATE so a pre-existing row is also forced to enabled = TRUE.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('rent_buddy_enabled', TRUE, 'Master switch for the Rent a Buddy feature')
ON CONFLICT (flag) DO UPDATE SET enabled = TRUE;

-- Remaining MVP flags — insert only; do not overwrite operator choices.
--
-- SEED NEUTRALISED 2026-08-12 — two rows removed from this statement:
-- RENT_BUDDY_CASH_BALANCE_ENABLED and RENT_BUDDY_DELAYED_POSTING_REQUIRED.
--
-- Both were seeded here, live in production, and read by NOTHING in either
-- shipping tree. The seven that remain are all genuinely read: RENT_BUDDY_MVP_MODE
-- and the six gates consulted through getFlag() in routes/rentABuddyRollout.ts,
-- each returning a 403 when off.
--
-- This is the REMOVE-FROM-SEED outcome of docs/ops/flag-disposition.md: the
-- concept may still be wanted, but the seed path must not auto-create the row.
-- 2086_retire_unread_flags.sql deletes it from databases that already ran this
-- migration; removing it here is the other half, so a fresh database never
-- creates it again. Deleting without neutralising would have the next restore
-- re-create exactly what 2086 removed. Editing an applied migration is
-- deliberate and is the same remedy 2080 applied to the COMPASS_* rows.
--
-- RENT_BUDDY_DELAYED_POSTING_REQUIRED is worth a note: the name is a
-- REQUIREMENT, not a capability, so an operator could reasonably read it as a
-- policy switch that imposes a posting delay. It imposed nothing in either
-- position.
--
-- Their INERT_SEEDED_FLAGS entries are removed from
-- scripts/check-flag-polarity.mjs in this commit, as rule R7 requires once a
-- flag is no longer seeded.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('RENT_BUDDY_MVP_MODE',                FALSE, 'MVP mode: restrict categories to city/language/arrival/shopping/content; block nightlife, group, concierge, packages, bidding, instant buddy, cash balance in high-risk cities, private meetup, unverified users'),
  ('RENT_BUDDY_ADMIN_ONLY_MODE',         FALSE, 'Admin-only mode: only users with admin role can access Rent a Buddy'),
  ('RENT_BUDDY_BETA_ONLY_MODE',          FALSE, 'Beta-only mode: only users with active beta access can use Rent a Buddy'),
  ('RENT_BUDDY_NIGHTLIFE_ENABLED',       FALSE, 'Enable nightlife category bookings'),
  ('RENT_BUDDY_GROUP_BOOKINGS_ENABLED',  FALSE, 'Enable group bookings (group_size > 4)'),
  ('RENT_BUDDY_PACKAGES_ENABLED',        FALSE, 'Enable pre-built packages in booking flow'),
  ('RENT_BUDDY_OFFERS_ENABLED',          FALSE, 'Enable buddy offers/bidding system')
ON CONFLICT (flag) DO NOTHING;
