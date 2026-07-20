-- 0163: columns written by high-traffic write paths that were missing from the
-- live schema (found by the task-1925 wizard-write-path drift audit).
--
-- One unknown column fails an entire PostgREST insert/update, so each of
-- these breaks its whole write path while missing:
--   * posts.filter_id / filter_intensity / media_duration_seconds — written
--     unconditionally by POST /posts (post-creation wizard).
--   * rent_buddy_bookings.country_code — written by the rebook insert.
--   * rent_buddy_policy_flags.updated_at — written by the admin
--     resolve/update path.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS filter_id text NOT NULL DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS filter_intensity integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS media_duration_seconds numeric;

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE rent_buddy_policy_flags
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
