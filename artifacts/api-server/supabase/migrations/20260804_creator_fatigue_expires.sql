-- Migration: add expires_at to viewer_creator_fatigue, add creator cap
-- config keys, and add the atomic increment RPC used by the fatigue tracker.

-- ── 1. Add expires_at column ──────────────────────────────────────────────────
ALTER TABLE viewer_creator_fatigue
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- Index for the batchLoadFatiguedCreators query that filters on expires_at > now()
CREATE INDEX IF NOT EXISTS viewer_creator_fatigue_expires_at_idx
  ON viewer_creator_fatigue (viewer_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- ── 2. Creator-cap ranking_config defaults ────────────────────────────────────
INSERT INTO ranking_config (key, value, description) VALUES
  ('ranking.caps.maxPerPage',           3,  'Max items from one creator per feed page'),
  ('ranking.caps.maxConsecutive',        2,  'Max consecutive items from one creator in a feed'),
  ('ranking.caps.fatigueHalfLifeHours', 48, 'Half-life in hours for the fatigue score exponential decay'),
  ('ranking.caps.fatigueThreshold',      5,  'Impression count that triggers a fatigue expires_at window')
ON CONFLICT (key) DO NOTHING;

-- ── 3. Atomic fatigue increment RPC ─────────────────────────────────────────
-- Called fire-and-forget by rankLog.ts after every impression batch.
-- Handles INSERT (first impression) and UPDATE (subsequent impressions)
-- atomically, decaying the existing fatigue_score over elapsed time before
-- adding the new impression's contribution.
CREATE OR REPLACE FUNCTION increment_creator_fatigue_batch(
  p_viewer_id           UUID,
  p_creator_ids         UUID[],
  p_half_life_hours     INT     DEFAULT 48,
  p_fatigue_threshold   INT     DEFAULT 5
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cid UUID;
BEGIN
  FOREACH cid IN ARRAY p_creator_ids LOOP
    INSERT INTO viewer_creator_fatigue
      (viewer_id, creator_id, recent_impressions, last_impression_at, fatigue_score, expires_at)
    VALUES
      (p_viewer_id, cid, 1, now(), 1.0, NULL)
    ON CONFLICT (viewer_id, creator_id) DO UPDATE SET
      recent_impressions = viewer_creator_fatigue.recent_impressions + 1,
      last_impression_at = now(),
      fatigue_score = LEAST(10.0,
        viewer_creator_fatigue.fatigue_score
          * POWER(0.5,
              EXTRACT(EPOCH FROM (now() - viewer_creator_fatigue.last_impression_at))
              / (p_half_life_hours::FLOAT * 3600.0)
            )
        + 1.0
      ),
      expires_at = CASE
        WHEN viewer_creator_fatigue.recent_impressions + 1 >= p_fatigue_threshold
          THEN now() + make_interval(hours => p_half_life_hours)
        ELSE viewer_creator_fatigue.expires_at
      END;
  END LOOP;
END;
$$;
