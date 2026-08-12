-- Migration 0051: Compass Foundation
-- Creates compass_user_profiles, compass_user_preferences,
-- compass_user_context_snapshots, compass_intent_modes tables,
-- and seeds all 9 Compass feature flags.

-- ── compass_user_profiles ────────────────────────────────────────────────────
-- Stores the last computed intelligence profile snapshot per user.
-- Written by CompassProfileService (server-side only, service role).
CREATE TABLE IF NOT EXISTS public.compass_user_profiles (
  user_id                   UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  preferred_cities          TEXT[]   NOT NULL DEFAULT '{}',
  preferred_languages       TEXT[]   NOT NULL DEFAULT '{}',
  budget_style              TEXT,                          -- backpacker|mid-range|luxury|flexible
  travel_styles             TEXT[]   NOT NULL DEFAULT '{}',
  social_style              TEXT,                          -- solo|small_group|large_group|flexible
  safety_preference         TEXT     NOT NULL DEFAULT 'standard',   -- standard|cautious|relaxed
  visibility_preference     TEXT     NOT NULL DEFAULT 'public',     -- public|semi_private|private
  block_count               INT      NOT NULL DEFAULT 0,
  blocker_count             INT      NOT NULL DEFAULT 0,
  trust_score               NUMERIC(5,2),
  trust_level               TEXT,
  active_user_score         NUMERIC(5,2),
  has_active_trip           BOOLEAN  NOT NULL DEFAULT FALSE,
  has_active_booking        BOOLEAN  NOT NULL DEFAULT FALSE,
  upcoming_trip_within_48h  BOOLEAN  NOT NULL DEFAULT FALSE,
  current_city              TEXT,
  current_country           TEXT,
  safe_return_active        BOOLEAN  NOT NULL DEFAULT FALSE,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── compass_user_preferences ─────────────────────────────────────────────────
-- User-controlled tuning knobs for the Compass system.
CREATE TABLE IF NOT EXISTS public.compass_user_preferences (
  user_id                UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  compass_enabled        BOOLEAN  NOT NULL DEFAULT TRUE,
  intent_mode_override   TEXT,                            -- NULL = auto-detect
  show_explanations      BOOLEAN  NOT NULL DEFAULT TRUE,
  budget_filter          TEXT,                            -- e.g. "backpacker", "luxury"
  min_trust_level        TEXT,                            -- e.g. "building_trust"
  exclude_budget_styles  TEXT[]   NOT NULL DEFAULT '{}',
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── compass_user_context_snapshots ───────────────────────────────────────────
-- Append-only audit log of context + intent mode computations per user.
CREATE TABLE IF NOT EXISTS public.compass_user_context_snapshots (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_state  TEXT        NOT NULL,
  intent_mode    TEXT        NOT NULL,
  secondary_modes TEXT[]     NOT NULL DEFAULT '{}',
  signals        JSONB       NOT NULL DEFAULT '{}',
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_context_snapshots_user_at_idx
  ON public.compass_user_context_snapshots(user_id, computed_at DESC);

-- ── compass_intent_modes ─────────────────────────────────────────────────────
-- Reference / config table for each intent mode.
CREATE TABLE IF NOT EXISTS public.compass_intent_modes (
  mode          TEXT        PRIMARY KEY,
  display_name  TEXT        NOT NULL,
  description   TEXT,
  icon          TEXT,
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  min_trust_level TEXT,
  night_only    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.compass_user_profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compass_user_preferences      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compass_user_context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compass_intent_modes          ENABLE ROW LEVEL SECURITY;

-- compass_user_profiles: users read their own; service role writes
CREATE POLICY "compass_profiles_select_own"
  ON public.compass_user_profiles FOR SELECT
  USING (auth.uid() = user_id);

-- compass_user_preferences: users manage their own row
CREATE POLICY "compass_prefs_select_own"
  ON public.compass_user_preferences FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "compass_prefs_insert_own"
  ON public.compass_user_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "compass_prefs_update_own"
  ON public.compass_user_preferences FOR UPDATE
  USING (auth.uid() = user_id);

-- compass_user_context_snapshots: users read their own; service role inserts
CREATE POLICY "compass_context_select_own"
  ON public.compass_user_context_snapshots FOR SELECT
  USING (auth.uid() = user_id);

-- compass_intent_modes: public read
CREATE POLICY "compass_intent_modes_public_read"
  ON public.compass_intent_modes FOR SELECT
  USING (TRUE);

-- ── Seed intent mode reference rows ──────────────────────────────────────────

INSERT INTO public.compass_intent_modes (mode, display_name, description, icon) VALUES
  ('explore_now',  'Explore Now',  'Discovering places and people nearby in real time', '🗺️'),
  ('plan_ahead',   'Plan Ahead',   'Planning future trips and activities',               '📋'),
  ('arrival_mode', 'Arrival Mode', 'Just arrived or arriving soon at a destination',    '✈️'),
  ('night_mode',   'Night Mode',   'Evening out — nightlife and late-night options',    '🌙'),
  ('social_mode',  'Social Mode',  'Meeting people and connecting with travelers',      '👥'),
  ('safety_mode',  'Safety Mode',  'Prioritising safety — safe return active',          '🛡️'),
  ('creator_mode', 'Creator Mode', 'Creating and sharing content',                      '📸'),
  ('budget_mode',  'Budget Mode',  'Stretching the budget — value-focused options',    '💰'),
  ('private_mode', 'Private Mode', 'Low-visibility session — privacy-first feed',       '🔒')
ON CONFLICT (mode) DO NOTHING;

-- ── Seed the Compass feature flags that are actually read ────────────────────
--
-- RETIRED 2026-08-12: six of the nine flags seeded here have been removed from
-- this statement. They were:
--
--   COMPASS_FRONTLOAD_ENABLED                  COMPASS_ADMIN_CONTROLS_ENABLED
--   COMPASS_ACTIVE_REWARD_ENABLED              COMPASS_ABUSE_DEFENSE_ENABLED
--   COMPASS_EXPLAIN_WHY_ENABLED                COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED
--
-- None had a reader. compass/flags.ts loadFlags() selects every row matching
-- `COMPASS_%` into a Record on each request, so all six were LOADED on every
-- Compass call — but no caller ever asked isEnabled() for these six names, and
-- being loaded is not being read. Every isEnabled() argument in the tree is a
-- string literal, and the only COMPASS names among them are COMPASS_ENABLED,
-- COMPASS_V1_RULE_BASED_ENABLED and COMPASS_TELEGRAPH.
--
-- Four of the six read TRUE in production while the engine each one named ran
-- unconditionally: an operator reading the admin list would have concluded that
-- frontloading, explanation cards, admin controls and Compass abuse defence
-- were switched on by these rows. They were not switched by anything.
--
-- Why they were invisible for so long: this statement writes
-- `INSERT INTO public.feature_flags`, and the seed scanner in
-- scripts/check-flag-polarity.mjs matched only the unqualified
-- `INSERT INTO feature_flags` until 2026-08-12. Its rule "every seeded flag is
-- either read or declared inert" cannot fail on a flag it never saw.
--
-- They are removed HERE so a fresh database never creates them, and deleted
-- from existing databases by src/migrations/2080_retire_inert_seeded_flags.sql.
-- Editing this applied migration is deliberate: it is the `remove-from-seed`
-- remedy, and leaving the INSERT in place would mean a new environment
-- re-creates the exact rows 2080 exists to remove. Same reasoning, same shape,
-- as the freeze_* retirement in 0065_phase7_safety.sql / 0209.
--
-- ⚠ NOTE THE CONFLICT CLAUSE BELOW. Unlike most seeds in this tree it is
-- `DO UPDATE SET description`, not `DO NOTHING` — re-running this migration
-- rewrites descriptions of existing rows. That is unchanged and intentional;
-- it is called out because it means this statement is not inert on re-run.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('COMPASS_ENABLED',
   TRUE,
   'Master switch — enables the Compass intelligence system'),
  ('COMPASS_V1_RULE_BASED_ENABLED',
   TRUE,
   'Use rule-based intent-mode detection (Phase 1 baseline)'),
  ('COMPASS_FALLBACK_MODE_ENABLED',
   TRUE,
   'Return safe fallback response when Compass logic fails or flag is off')
ON CONFLICT (flag) DO UPDATE SET description = EXCLUDED.description;
