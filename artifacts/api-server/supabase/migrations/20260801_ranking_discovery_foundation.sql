-- Migration: ranking_discovery_foundation
-- Creates tables, indexes, config rows, and feature flags for the
-- activity-aware ranking system (Phase 1 — shadow mode, no user-visible changes).
-- Safe to re-run: IF NOT EXISTS throughout; inserts use ON CONFLICT DO NOTHING.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. creator_activity_scores
--    Per-creator activity score breakdown used by the ranking engine.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creator_activity_scores (
  user_id                       UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  score                         NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  recent_contribution_score     NUMERIC(5,2)  NOT NULL DEFAULT 0,
  consistency_score             NUMERIC(5,2)  NOT NULL DEFAULT 0,
  community_participation_score NUMERIC(5,2)  NOT NULL DEFAULT 0,
  positive_response_score       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  maintenance_score             NUMERIC(5,2)  NOT NULL DEFAULT 0,
  spam_penalty                  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  repetition_penalty            NUMERIC(5,2)  NOT NULL DEFAULT 0,
  safety_multiplier             NUMERIC(5,4)  NOT NULL DEFAULT 1.0,
  calculation_version           TEXT          NOT NULL DEFAULT '1.0',
  calculated_at                 TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT creator_activity_scores_pkey PRIMARY KEY (user_id)
);

COMMENT ON TABLE creator_activity_scores IS
  'Per-creator activity score components used by the discovery ranking engine. Recalculated periodically by a background job.';

CREATE UNIQUE INDEX IF NOT EXISTS creator_activity_scores_user_id_idx
  ON creator_activity_scores (user_id);

CREATE INDEX IF NOT EXISTS creator_activity_scores_calculated_at_idx
  ON creator_activity_scores (calculated_at);

-- RLS: internal ranking data — only service role (which bypasses RLS) may access.
ALTER TABLE creator_activity_scores ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'creator_activity_scores' AND policyname = 'cas_deny_public'
  ) THEN
    CREATE POLICY cas_deny_public ON creator_activity_scores FOR ALL USING (FALSE);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. content_distribution_stats
--    Tracks impression / engagement counters per piece of content so the
--    ranking engine can detect and boost under-exposed content.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE underexposure_status_enum AS ENUM (
    'pending_evaluation',
    'boosting',
    'evaluated',
    'suppressed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS content_distribution_stats (
  content_type        TEXT                        NOT NULL,
  content_id          UUID                        NOT NULL,
  creator_id          UUID                        REFERENCES auth.users(id) ON DELETE SET NULL,
  eligible_impressions BIGINT                     NOT NULL DEFAULT 0,
  unique_viewers      BIGINT                      NOT NULL DEFAULT 0,
  opens               BIGINT                      NOT NULL DEFAULT 0,
  dwell_time_ms       BIGINT                      NOT NULL DEFAULT 0,
  saves               BIGINT                      NOT NULL DEFAULT 0,
  shares              BIGINT                      NOT NULL DEFAULT 0,
  comments            BIGINT                      NOT NULL DEFAULT 0,
  positive_actions    BIGINT                      NOT NULL DEFAULT 0,
  negative_actions    BIGINT                      NOT NULL DEFAULT 0,
  last_impression_at  TIMESTAMPTZ,
  underexposure_status underexposure_status_enum  NOT NULL DEFAULT 'pending_evaluation',
  evaluation_complete BOOLEAN                     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  CONSTRAINT content_distribution_stats_pkey PRIMARY KEY (content_type, content_id)
);

COMMENT ON TABLE content_distribution_stats IS
  'Impression and engagement counters per content item, used to detect and boost under-exposed content in the ranking feed.';

CREATE INDEX IF NOT EXISTS content_distribution_stats_creator_id_idx
  ON content_distribution_stats (creator_id);

CREATE INDEX IF NOT EXISTS content_distribution_stats_underexposure_status_idx
  ON content_distribution_stats (underexposure_status);

CREATE INDEX IF NOT EXISTS content_distribution_stats_evaluation_complete_idx
  ON content_distribution_stats (evaluation_complete);

-- RLS: internal ranking data — only service role (which bypasses RLS) may access.
ALTER TABLE content_distribution_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'content_distribution_stats' AND policyname = 'cds_deny_public'
  ) THEN
    CREATE POLICY cds_deny_public ON content_distribution_stats FOR ALL USING (FALSE);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. viewer_creator_fatigue
--    Per-viewer/creator pair tracking to prevent a single creator from
--    dominating any viewer's feed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS viewer_creator_fatigue (
  viewer_id           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id          UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recent_impressions  INT          NOT NULL DEFAULT 0,
  last_impression_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  fatigue_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT viewer_creator_fatigue_pkey PRIMARY KEY (viewer_id, creator_id)
);

COMMENT ON TABLE viewer_creator_fatigue IS
  'Tracks how often each viewer has seen content from each creator recently. Used to cap creator frequency in ranked feeds.';

CREATE INDEX IF NOT EXISTS viewer_creator_fatigue_viewer_id_idx
  ON viewer_creator_fatigue (viewer_id);

CREATE INDEX IF NOT EXISTS viewer_creator_fatigue_last_impression_at_idx
  ON viewer_creator_fatigue (last_impression_at);

-- RLS: per-user fatigue state — only service role (which bypasses RLS) may access.
ALTER TABLE viewer_creator_fatigue ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'viewer_creator_fatigue' AND policyname = 'vcf_deny_public'
  ) THEN
    CREATE POLICY vcf_deny_public ON viewer_creator_fatigue FOR ALL USING (FALSE);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ranking_config
--    Server-authoritative key/value configuration for ranking weights and
--    algorithm parameters. Values are numeric; descriptions are human-readable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ranking_config (
  key         TEXT         PRIMARY KEY,
  value       NUMERIC      NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE ranking_config IS
  'Server-authoritative numeric configuration for the ranking engine. Keys follow dot-notation (e.g. ranking.weights.relevance). Never hard-code these values in application code.';

-- RLS: anyone may read config values; only service role (which bypasses RLS) may write.
-- This mirrors the feature_flags pattern: SELECT open, no write policy = writes denied.
ALTER TABLE ranking_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ranking_config' AND policyname = 'rc_select_all'
  ) THEN
    CREATE POLICY rc_select_all ON ranking_config FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Seed default weights, penalties, shares, and activity parameters.
-- ON CONFLICT DO NOTHING makes this safe to re-run without overwriting live edits.
INSERT INTO ranking_config (key, value, description) VALUES
  -- Score weights (sum to 100)
  ('ranking.weights.relevance',      35, 'Share of the ranking score driven by relevance to viewer interests'),
  ('ranking.weights.freshness',      20, 'Share driven by recency of the content'),
  ('ranking.weights.quality',        15, 'Share driven by content quality signals'),
  ('ranking.weights.activity',       10, 'Share driven by creator activity score boost'),
  ('ranking.weights.engagement',     10, 'Share driven by engagement rate of the content'),
  ('ranking.weights.exploration',     5, 'Share reserved for serendipitous / outside-graph content'),
  ('ranking.weights.underexposure',   5, 'Share reserved for under-exposed content boost'),
  -- Penalties (subtracted from final score)
  ('ranking.penalties.repetition',   10, 'Score penalty applied when the viewer has seen very similar content recently'),
  ('ranking.penalties.fatigue',       8, 'Score penalty applied when viewer has seen many posts from this creator recently'),
  ('ranking.penalties.negativeFeedback', 15, 'Score penalty applied when the viewer has explicitly dismissed creator content'),
  -- Feed composition shares (% of slots allocated to each pool)
  ('ranking.shares.relevance',       52, 'Percentage of feed slots filled by the relevance-ranked pool'),
  ('ranking.shares.activeCreator',   15, 'Percentage of feed slots filled by active-creator pool'),
  ('ranking.shares.underexposed',    15, 'Percentage of feed slots filled by under-exposed content pool'),
  ('ranking.shares.newUser',         13, 'Percentage of feed slots filled by new-user / onboarding pool'),
  ('ranking.shares.exploration',      5, 'Percentage of feed slots filled by exploration pool'),
  -- Activity score parameters
  ('ranking.activity.maxBoost',      10, 'Maximum additional score points granted by creator activity boost'),
  ('ranking.activity.decayHalfLifeDays', 14, 'Half-life in days for the activity score exponential decay'),
  ('ranking.activity.capScore',     100, 'Maximum allowed raw creator activity score before normalisation')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ranking_debug_samples
--    Short-retention sampled ranking decisions for debugging and A/B analysis.
--    Only the service role may read rows. Rows older than 7 days are purged by
--    the cleanup function below (called from the application cleanup job).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ranking_debug_samples (
  id              BIGSERIAL    PRIMARY KEY,
  viewer_id       UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  content_type    TEXT         NOT NULL,
  content_id      UUID         NOT NULL,
  final_score     NUMERIC(8,4) NOT NULL,
  score_components JSONB       NOT NULL DEFAULT '{}',
  ranking_version TEXT         NOT NULL DEFAULT '1.0',
  surface         TEXT,
  sampled_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE ranking_debug_samples IS
  'Sampled ranking decisions retained for 7 days only. Service-role read access; purged nightly by the cleanup job.';

CREATE INDEX IF NOT EXISTS ranking_debug_samples_sampled_at_idx
  ON ranking_debug_samples (sampled_at);

CREATE INDEX IF NOT EXISTS ranking_debug_samples_viewer_id_idx
  ON ranking_debug_samples (viewer_id);

-- Enable RLS; only the service role (bypasses RLS) may read or write.
ALTER TABLE ranking_debug_samples ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ranking_debug_samples'
      AND policyname = 'rds_no_public_select'
  ) THEN
    -- Deny all access to non-service-role callers; service role bypasses RLS.
    CREATE POLICY rds_no_public_select
      ON ranking_debug_samples
      FOR ALL
      USING (FALSE);
  END IF;
END $$;

-- Cleanup function: delete rows older than 7 days.
-- Call this from the application nightly cleanup job (same pattern as
-- dailyBriefCleanup.ts). Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION purge_old_ranking_debug_samples()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM ranking_debug_samples
  WHERE sampled_at < now() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION purge_old_ranking_debug_samples() IS
  'Deletes ranking_debug_samples rows older than 7 days. Call nightly from the application cleanup scheduler.';

-- Restrict execute to the postgres superuser only; revoke broad PUBLIC grant.
REVOKE EXECUTE ON FUNCTION purge_old_ranking_debug_samples() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION purge_old_ranking_debug_samples() TO postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Feature flags
--    All flags default to FALSE so Stage 1 (shadow mode) launches with no
--    user-visible changes. Enable each flag when the corresponding service is
--    ready for production traffic.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('ACTIVITY_DISCOVERY_BOOST_ENABLED',    FALSE, 'Master switch: apply creator activity score boost to discovery rankings'),
  ('ACTIVITY_SCORE_VERSION',              FALSE, 'Use the v2 activity score calculation algorithm (v1 is default)'),
  ('ACTIVITY_SCORE_MAX_BOOST',            FALSE, 'Enable the configurable cap on activity-score ranking boost'),
  ('ACTIVITY_SCORE_DECAY_ENABLED',        FALSE, 'Apply exponential time-decay to creator activity scores'),
  ('NEW_CONTRIBUTOR_BOOST_ENABLED',       FALSE, 'Boost content from new creators who have not yet built an audience'),
  ('RETURNING_USER_BOOST_ENABLED',        FALSE, 'Boost feed diversity for viewers returning after a long absence'),
  ('UNDEREXPOSED_CONTENT_BOOST_ENABLED',  FALSE, 'Allocate feed slots to content that has not reached fair exposure yet'),
  ('DISCOVERY_DIVERSITY_ENABLED',         FALSE, 'Enforce creator-diversity and topic-diversity caps across the ranked feed'),
  ('CREATOR_FATIGUE_ENABLED',             FALSE, 'Apply per-viewer/creator fatigue penalty to limit creator frequency'),
  ('ANTI_GAMING_RANKING_ENABLED',         FALSE, 'Activate spam and repetition penalties in the ranking pipeline'),
  ('RANKING_EXPERIMENT_ENABLED',          FALSE, 'Enable A/B experiment layer for ranking algorithm variants')
ON CONFLICT (flag) DO NOTHING;
