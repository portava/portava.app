-- 2046_phash_dedup.sql
-- Adds perceptual hashing (pHash) support to post_media and creates the
-- media_dedup_groups table for near-duplicate collapse (display-only; original
-- posts are never deleted).

-- ── post_media additions ──────────────────────────────────────────────────────

-- 16-char hex string (64-bit difference hash) computed server-side on upload.
-- NULL when computation was skipped (videos, HEIC fallback, pre-existing rows).
ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS phash TEXT;

-- Worker flag: set TRUE once this row has been assigned to a dedup group (or
-- confirmed to have no near-duplicate neighbour in the same place).
ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS dedup_processed BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for the worker's "unprocessed images with a place" query.
CREATE INDEX IF NOT EXISTS idx_post_media_dedup_pending
  ON public.post_media (canonical_place_id, dedup_processed)
  WHERE phash IS NOT NULL
    AND canonical_place_id IS NOT NULL
    AND dedup_processed = FALSE;

-- ── media_dedup_groups ────────────────────────────────────────────────────────
-- One row per cluster of visually-similar images at the same canonical place.
-- representative_media_id points to the best (first seen) image in the cluster.
-- sample_media_ids stores up to 3 member ids for the collapsed-view chip.
-- bucket_key = first 8 hex chars of the representative's phash (used to shard
-- the pairwise Hamming check to O(bucket_size²) rather than O(place²)).

CREATE TABLE IF NOT EXISTS public.media_dedup_groups (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_place_id      UUID NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  representative_media_id UUID NOT NULL REFERENCES public.post_media(id) ON DELETE CASCADE,
  -- Denormalised phash of the representative — avoids a JOIN when comparing
  -- incoming rows against existing cluster representatives.
  representative_phash    TEXT,
  member_count            INT NOT NULL DEFAULT 1,
  sample_media_ids        UUID[] NOT NULL DEFAULT '{}',
  -- 8-char hex prefix of representative phash — metadata / coarse index.
  -- NOT used to restrict which rows compare against which; that caused
  -- cross-prefix near-duplicates to be missed silently.
  bucket_key              TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Look up groups for a place sorted by popularity (used by living page API).
CREATE INDEX IF NOT EXISTS idx_media_dedup_groups_place_count
  ON public.media_dedup_groups (canonical_place_id, member_count DESC);

-- Each cluster is uniquely identified by the place + representative media item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_dedup_groups_place_repr
  ON public.media_dedup_groups (canonical_place_id, representative_media_id);

-- ── media_dedup_memberships ───────────────────────────────────────────────────
-- Tracks which group each post_media row belongs to.
-- PK on media_id enforces that each media item belongs to at most one group.
-- This is the idempotency key for the dedup worker: upserting with
-- ON CONFLICT DO NOTHING means retries after a partial failure are no-ops,
-- so member_count (derived from a COUNT of memberships) is never inflated.

CREATE TABLE IF NOT EXISTS public.media_dedup_memberships (
  media_id   UUID PRIMARY KEY REFERENCES public.post_media(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES public.media_dedup_groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast membership count per group (used by worker to derive member_count).
CREATE INDEX IF NOT EXISTS idx_media_dedup_memberships_group
  ON public.media_dedup_memberships (group_id);
