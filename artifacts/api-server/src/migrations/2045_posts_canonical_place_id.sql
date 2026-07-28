-- 2045_posts_canonical_place_id.sql
-- Wires posts and post_media to the venue-level places table so community
-- content can be aggregated under a single canonical place entity.
-- Adds place_mismatch_reports for the wrong-place report flow.

-- ── posts ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid
    REFERENCES public.places(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_posts_canonical_place
  ON public.posts (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL;

-- ── post_media ────────────────────────────────────────────────────────────────

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid
    REFERENCES public.places(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_post_media_canonical_place
  ON public.post_media (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL;

-- ── place_mismatch_reports ────────────────────────────────────────────────────
-- Stores user reports that a post has been attached to the wrong canonical place.
-- Status lifecycle: pending → resolved.
-- Resolving with action='accept' nulls posts.canonical_place_id so the post can
-- be re-resolved; action='reject' closes the report without changing the post.

CREATE TABLE IF NOT EXISTS public.place_mismatch_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id            uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  reporter_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_place_id  uuid REFERENCES public.places(id) ON DELETE SET NULL,
  reason             text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'resolved')),
  resolved_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_action    text CHECK (resolved_action IN ('accept', 'reject')),
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_place_mismatch_reports_post
  ON public.place_mismatch_reports (post_id);

CREATE INDEX IF NOT EXISTS idx_place_mismatch_reports_status
  ON public.place_mismatch_reports (status, created_at DESC)
  WHERE status = 'pending';

-- One pending report per (post, reporter) — prevents duplicate submissions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_place_mismatch_reports_unique_pending
  ON public.place_mismatch_reports (post_id, reporter_id)
  WHERE status = 'pending';
