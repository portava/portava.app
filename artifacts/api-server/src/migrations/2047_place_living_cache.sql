-- Place Living Page API infrastructure
-- place_living_cache: stale-while-revalidate living page envelope (SWR)
CREATE TABLE IF NOT EXISTS place_living_cache (
  place_id   UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  payload    JSONB    NOT NULL,
  cached_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sparse     BOOLEAN  NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_place_living_cache_cached_at
  ON place_living_cache (cached_at);

-- place_best_of: precomputed best-of collections per place (worker-populated)
CREATE TABLE IF NOT EXISTS place_best_of (
  place_id         UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  top_videos       JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_photos       JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_viewpoints   JSONB NOT NULL DEFAULT '[]'::jsonb,
  food_nearby      JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_experiences  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- place_top_contributors: cached top contributors per place (worker-populated)
CREATE TABLE IF NOT EXISTS place_top_contributors (
  place_id           UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL,
  contribution_count INT  NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (place_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_place_top_contributors_count
  ON place_top_contributors (place_id, contribution_count DESC);

-- place_ai_summaries: cached AI-generated summaries with audit trail
CREATE TABLE IF NOT EXISTS place_ai_summaries (
  place_id       UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  text           TEXT    NOT NULL,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  post_ids_used  UUID[]  NOT NULL DEFAULT '{}'
);

-- place_cache_invalidation_queue: lightweight queue for background revalidation
-- The precompute worker (Task 6) drains this queue and rebuilds place_best_of.
-- After draining, the living endpoint re-caches on the next request.
CREATE TABLE IF NOT EXISTS place_cache_invalidation_queue (
  place_id   UUID PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
  queued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
