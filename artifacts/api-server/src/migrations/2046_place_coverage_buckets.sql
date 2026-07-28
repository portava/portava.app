-- Migration 2046: place_coverage_buckets + posts.bucket_classified
-- Tracks per-place content coverage across 10 bucket types.
-- Used by the novelty ranking boost and the thin-buckets endpoint.

CREATE TABLE IF NOT EXISTS place_coverage_buckets (
  canonical_place_id UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  bucket             TEXT NOT NULL,
  post_count         INT  NOT NULL DEFAULT 0,
  last_post_at       TIMESTAMPTZ,
  PRIMARY KEY (canonical_place_id, bucket),
  CONSTRAINT bucket_name_check CHECK (bucket IN (
    'drone', 'night', 'sunrise', 'underwater', 'adventure',
    'food_nearby', 'hidden_angles', 'tips', 'rainy_season', 'festival'
  ))
);

CREATE INDEX IF NOT EXISTS idx_place_coverage_buckets_place_id
  ON place_coverage_buckets (canonical_place_id);

CREATE INDEX IF NOT EXISTS idx_place_coverage_buckets_thin
  ON place_coverage_buckets (canonical_place_id, post_count)
  WHERE post_count < 5;

-- Stores the coverage bucket types classified for this post.
-- Populated at write-time (post creation) and by the Phase-2 backfill worker.
-- Nullable: NULL means unclassified, '{}' means classified with no matches.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS post_buckets TEXT[] DEFAULT NULL;

-- Tracks whether bucket classification has been run for a post.
-- Used by the backfill worker (Phase 2) to avoid re-processing.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS bucket_classified BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_posts_bucket_classified_pending
  ON posts (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL AND bucket_classified = false;

-- Per-post idempotency ledger: ensures each (post, bucket) pair is counted
-- at most once in place_coverage_buckets regardless of retries or races.
CREATE TABLE IF NOT EXISTS post_bucket_ledger (
  post_id            UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  canonical_place_id UUID NOT NULL,
  bucket             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_post_bucket_ledger_place
  ON post_bucket_ledger (canonical_place_id, bucket);

-- Atomic single-row increment: INSERT … ON CONFLICT DO UPDATE post_count + 1.
-- Called once per (place, bucket) after a new ledger row is confirmed inserted.
-- Using a function ensures the increment is never subject to fetch-then-write races.
CREATE OR REPLACE FUNCTION increment_bucket_count(
  p_canonical_place_id UUID,
  p_bucket             TEXT,
  p_last_post_at       TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO place_coverage_buckets (canonical_place_id, bucket, post_count, last_post_at)
  VALUES (p_canonical_place_id, p_bucket, 1, p_last_post_at)
  ON CONFLICT (canonical_place_id, bucket)
  DO UPDATE SET
    post_count   = place_coverage_buckets.post_count + 1,
    last_post_at = EXCLUDED.last_post_at;
END;
$$;
