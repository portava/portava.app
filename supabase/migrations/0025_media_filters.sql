-- Migration: 0025_media_filters
-- Adds filter_id, filter_intensity, media_thumbnail_url, and media_duration_seconds
-- to both `posts` and `highlights` tables.
-- Old rows default to 'original' / 100 so they render unchanged.

-- ── posts ──────────────────────────────────────────────────────────────────
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS filter_id              TEXT    DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS filter_intensity       INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS media_thumbnail_url    TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_seconds INTEGER;

-- Partial index for analytics: only rows that actually have a non-original filter
CREATE INDEX IF NOT EXISTS posts_filter_id_idx
  ON public.posts (filter_id)
  WHERE filter_id IS NOT NULL AND filter_id <> 'original';

-- ── highlights ────────────────────────────────────────────────────────────
ALTER TABLE public.highlights
  ADD COLUMN IF NOT EXISTS filter_id              TEXT    DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS filter_intensity       INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS media_thumbnail_url    TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_seconds INTEGER;

CREATE INDEX IF NOT EXISTS highlights_filter_id_idx
  ON public.highlights (filter_id)
  WHERE filter_id IS NOT NULL AND filter_id <> 'original';
