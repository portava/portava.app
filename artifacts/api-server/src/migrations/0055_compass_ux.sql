-- 0055_compass_ux.sql
-- Compass Phase 5 — Intelligence UX tables
--
-- Creates:
--   compass_feedback_events         — raw feedback action log
--   compass_explanation_reasons     — optional override explanations (admin-editable)
--   compass_notification_decisions  — audit log for notification send/suppress decisions
--   compass_abuse_flags             — patterns detected by CompassAbuseDefenseEngine
--   compass_served_recommendations  — per-user recommendation records used by the /why endpoint
--
-- All tables enable RLS.  Service role handles all writes.
-- Users may read their own rows where indicated.

-- ── compass_feedback_events ──────────────────────────────────────────────────
-- Raw append-only log of every feedback action a user takes on a Compass item.

CREATE TABLE IF NOT EXISTS public.compass_feedback_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recommendation_id TEXT      NOT NULL,   -- opaque token (base64url{userId,explanationKey})
  item_id         TEXT        NOT NULL,
  item_type       TEXT        NOT NULL,
  action          TEXT        NOT NULL,   -- see FEEDBACK_ACTIONS in CompassFeedbackEngine
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_feedback_events_user_idx
  ON public.compass_feedback_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS compass_feedback_events_action_idx
  ON public.compass_feedback_events (action, created_at DESC);

ALTER TABLE public.compass_feedback_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own feedback events"
  ON public.compass_feedback_events FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_explanation_reasons ──────────────────────────────────────────────
-- Optional admin-editable overrides for explanation key → template strings.
-- When absent the engine falls back to its built-in map.

CREATE TABLE IF NOT EXISTS public.compass_explanation_reasons (
  explanation_key TEXT PRIMARY KEY,   -- matches explanationKey from CompassFeedBuilder
  template        TEXT NOT NULL,      -- human-readable "Why am I seeing this?" string
  is_sensitive    BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE → never show real reason; use generic
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.compass_explanation_reasons ENABLE ROW LEVEL SECURITY;

-- Service role manages; no user access to sensitive flags

-- ── compass_notification_decisions ──────────────────────────────────────────
-- Append-only audit log for every notification the engine evaluates.
-- outcome: 'sent' | 'suppressed_quiet_hours' | 'suppressed_category_muted'
--        | 'suppressed_safety_filter' | 'suppressed_private_location'
--        | 'suppressed_ignored_category'

CREATE TABLE IF NOT EXISTS public.compass_notification_decisions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notification_type TEXT      NOT NULL,
  priority_level  INT         NOT NULL,   -- 1 (highest) – 10 (lowest)
  outcome         TEXT        NOT NULL,
  suppression_reason TEXT,
  payload_hash    TEXT,                   -- sha256 of stripped payload (no location data)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_notification_decisions_user_idx
  ON public.compass_notification_decisions (user_id, created_at DESC);

ALTER TABLE public.compass_notification_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own notification decisions"
  ON public.compass_notification_decisions FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_abuse_flags ──────────────────────────────────────────────────────
-- Detected abuse patterns.  severity: 'low' | 'medium' | 'high' | 'severe'
-- status: 'pending' | 'confirmed' | 'dismissed'

CREATE TABLE IF NOT EXISTS public.compass_abuse_flags (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type    TEXT        NOT NULL,   -- mutual_review_ring | booking_loop | referral_farm
                                          -- | hashtag_spam | geotag_farming | available_now_abuse
                                          -- | refund_abuse | comment_pod
  involved_users  UUID[]      NOT NULL DEFAULT '{}',
  severity        TEXT        NOT NULL DEFAULT 'medium',
  status          TEXT        NOT NULL DEFAULT 'pending',
  evidence        JSONB       NOT NULL DEFAULT '{}',
  reach_reduction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  reward_zeroed   BOOLEAN     NOT NULL DEFAULT FALSE,
  admin_notes     TEXT,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS compass_abuse_flags_status_idx
  ON public.compass_abuse_flags (status, severity, detected_at DESC);

CREATE INDEX IF NOT EXISTS compass_abuse_flags_users_idx
  ON public.compass_abuse_flags USING GIN (involved_users);

ALTER TABLE public.compass_abuse_flags ENABLE ROW LEVEL SECURITY;

-- Only service role reads/writes abuse flags; no user access

-- ── compass_served_recommendations ───────────────────────────────────────────
-- Per-user served recommendation registry.  The feed route writes one row per
-- item before returning the response; the /why endpoint reads from this table
-- to verify the recommendation was legitimately served to the caller and to
-- resolve the stored explanation_key.
--
-- NOTE: compass_recommendation_scores (created in 0052_compass_pipeline_logs)
-- is a separate DEBUG table for score-component inspection and is NOT this table.

CREATE TABLE IF NOT EXISTS public.compass_served_recommendations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recommendation_id TEXT      NOT NULL UNIQUE,  -- opaque HMAC-signed token from CompassExplanationEngine
  explanation_key TEXT        NOT NULL,
  item_id         TEXT        NOT NULL,
  item_type       TEXT        NOT NULL,
  section_name    TEXT,
  explanation_looked_up_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_served_recs_user_idx
  ON public.compass_served_recommendations (user_id, created_at DESC);

ALTER TABLE public.compass_served_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own served recommendations"
  ON public.compass_served_recommendations FOR SELECT
  USING (auth.uid() = user_id);
