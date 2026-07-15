-- 0128_posts_canonical_location.sql
-- Adds the canonical location reference to posts, linking a post's tagged
-- location to the universal canonical_locations registry (see 0125).
-- Written by the postcard composer (and future post composers) when the user
-- picks a location through the universal location picker. Nullable — legacy
-- posts and free-text locations remain valid.

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS canonical_location_id uuid
    REFERENCES public.canonical_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_posts_canonical_location
  ON public.posts (canonical_location_id)
  WHERE canonical_location_id IS NOT NULL;
