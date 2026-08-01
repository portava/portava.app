-- DiscoveryRankingService: tracks per-item impression counts and underexposure status.
--
-- Canonical schema (fresh DB): item_id TEXT PRIMARY KEY, counters, underexposure_status,
-- first_evaluated_at, last_updated_at.
--
-- Live-compat path: on the production DB this table pre-existed with a different column
-- set (content_type+content_id composite PK, unique_viewers, opens, dwell_time_ms, …).
-- The CREATE TABLE below is a no-op there; the ADD COLUMN and guarded DO-blocks below
-- bring the live table up to the canonical shape without breaking a fresh replay.
--
-- underexposure_status values:
--   'pending_evaluation' — not yet enough impressions to classify
--   'boosting'           — eligible for the underexposure ranking boost
--   'normal'             — sufficient distribution; no boost

CREATE TABLE IF NOT EXISTS content_distribution_stats (
  item_id               TEXT        PRIMARY KEY,
  eligible_impressions  INTEGER     NOT NULL DEFAULT 0,
  negative_signal_count INTEGER     NOT NULL DEFAULT 0,
  underexposure_status  TEXT        NOT NULL DEFAULT 'pending_evaluation'
    CHECK (underexposure_status IN ('pending_evaluation', 'boosting', 'normal')),
  first_evaluated_at    TIMESTAMPTZ,
  last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns that the service code references by name (no-op on fresh DB where the
-- CREATE TABLE above already includes them, safe on the pre-existing live table).
ALTER TABLE content_distribution_stats
  ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE content_distribution_stats
  ADD COLUMN IF NOT EXISTS negative_signal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_distribution_stats
  ADD COLUMN IF NOT EXISTS first_evaluated_at TIMESTAMPTZ;
ALTER TABLE content_distribution_stats
  ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Unique index on item_id so ON CONFLICT (item_id) in the RPC resolves correctly.
-- Must be non-partial — ON CONFLICT does not accept partial indexes as targets.
CREATE UNIQUE INDEX IF NOT EXISTS content_distribution_stats_item_id_idx
  ON content_distribution_stats (item_id);

-- ── Live-compat only: set defaults on legacy NOT NULL columns ─────────────────
--
-- On the pre-existing live table the original PK columns (content_type, content_id)
-- and counter columns are NOT NULL without defaults, which prevents the RPC's
-- item_id-only INSERT from succeeding.  Each block is guarded by a column-existence
-- check so it is completely skipped on a fresh DB (where those columns don't exist).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_distribution_stats'
      AND column_name='content_type'
  ) THEN
    ALTER TABLE content_distribution_stats ALTER COLUMN content_type SET DEFAULT 'item';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_distribution_stats'
      AND column_name='content_id'
  ) THEN
    ALTER TABLE content_distribution_stats ALTER COLUMN content_id SET DEFAULT gen_random_uuid();
  END IF;
END $$;

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'eligible_impressions','unique_viewers','opens','dwell_time_ms',
    'saves','shares','comments','positive_actions','negative_actions'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='content_distribution_stats'
        AND column_name=col
    ) THEN
      EXECUTE format(
        'ALTER TABLE content_distribution_stats ALTER COLUMN %I SET DEFAULT 0', col
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_distribution_stats'
      AND column_name='evaluation_complete'
  ) THEN
    ALTER TABLE content_distribution_stats ALTER COLUMN evaluation_complete SET DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_distribution_stats'
      AND column_name='created_at'
  ) THEN
    ALTER TABLE content_distribution_stats ALTER COLUMN created_at SET DEFAULT NOW();
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_distribution_stats'
      AND column_name='updated_at'
  ) THEN
    ALTER TABLE content_distribution_stats ALTER COLUMN updated_at SET DEFAULT NOW();
  END IF;
END $$;

-- RLS: service role manages all writes; no user-facing read policy (ranking is internal).
ALTER TABLE content_distribution_stats ENABLE ROW LEVEL SECURITY;

-- increment_distribution_stats: atomically increment counters and recompute status.
-- Called fire-and-forget by rank_events on every impression.
CREATE OR REPLACE FUNCTION increment_distribution_stats(
  p_item_id          TEXT,
  p_viewer_id        TEXT,
  p_negative_signal  BOOLEAN,
  p_threshold        INTEGER DEFAULT 100,
  p_suppression_rate FLOAT   DEFAULT 0.3
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_impressions INTEGER;
  v_negatives   INTEGER;
  v_new_status  TEXT;
BEGIN
  INSERT INTO content_distribution_stats (
    item_id, eligible_impressions, negative_signal_count,
    underexposure_status, first_evaluated_at, last_updated_at
  )
  VALUES (
    p_item_id,
    1,
    CASE WHEN p_negative_signal THEN 1 ELSE 0 END,
    'pending_evaluation',
    NOW(),
    NOW()
  )
  ON CONFLICT (item_id) DO UPDATE SET
    eligible_impressions  = content_distribution_stats.eligible_impressions + 1,
    negative_signal_count = content_distribution_stats.negative_signal_count
                            + CASE WHEN p_negative_signal THEN 1 ELSE 0 END,
    last_updated_at       = NOW()
  RETURNING eligible_impressions, negative_signal_count
  INTO v_impressions, v_negatives;

  -- Classify status once threshold is reached
  IF v_impressions >= p_threshold THEN
    IF v_negatives::FLOAT / NULLIF(v_impressions, 0) >= p_suppression_rate THEN
      v_new_status := 'normal';
    ELSE
      v_new_status := 'boosting';
    END IF;
    UPDATE content_distribution_stats
       SET underexposure_status = v_new_status,
           first_evaluated_at   = COALESCE(first_evaluated_at, NOW())
     WHERE item_id = p_item_id;
  END IF;
END;
$$;

-- Privilege hardening: SECURITY DEFINER functions must not be callable by
-- untrusted roles.  Revoke the default PUBLIC execute grant and restrict to
-- service_role only — consistent with all other SECURITY DEFINER RPCs in this
-- repo.
REVOKE ALL ON FUNCTION increment_distribution_stats(TEXT, TEXT, BOOLEAN, INTEGER, FLOAT) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_distribution_stats(TEXT, TEXT, BOOLEAN, INTEGER, FLOAT) FROM anon;
REVOKE ALL ON FUNCTION increment_distribution_stats(TEXT, TEXT, BOOLEAN, INTEGER, FLOAT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_distribution_stats(TEXT, TEXT, BOOLEAN, INTEGER, FLOAT) TO service_role;
