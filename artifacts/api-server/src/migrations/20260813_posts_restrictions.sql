-- 20260813_posts_restrictions.sql
--
-- Adds geo_restriction, age_restriction_enabled, age_min, and age_max to
-- the posts table so the media feed eligibility filter can enforce them.
--
-- These fields are required by filterEligibleMediaCandidates in
-- mediaEligibility.ts, which is fail-closed: a post with geo_restriction
-- set is excluded when the viewer's country is unknown, and a post with
-- age_restriction_enabled = true is excluded when the viewer's age is unknown.
--
-- Column semantics:
--   geo_restriction          Comma-separated ISO-3166-1 alpha-2 country codes.
--                            NULL = no restriction (visible everywhere).
--   age_restriction_enabled  When true, age_min / age_max are enforced.
--                            Fail-closed: if viewer age is unknown the post
--                            is excluded.
--   age_min                  Minimum viewer age (inclusive). NULL = no lower bound.
--   age_max                  Maximum viewer age (inclusive). NULL = no upper bound.
--
-- Defaults: all NULL / false so existing posts behave exactly as before.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS geo_restriction         text,
  ADD COLUMN IF NOT EXISTS age_restriction_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS age_min                 smallint,
  ADD COLUMN IF NOT EXISTS age_max                 smallint;

COMMENT ON COLUMN posts.geo_restriction IS
  'Comma-separated ISO-3166-1 alpha-2 country codes where this post is allowed. NULL = no geographic restriction.';
COMMENT ON COLUMN posts.age_restriction_enabled IS
  'When true the post is age-restricted. Viewers with unknown age are excluded (fail-closed).';
COMMENT ON COLUMN posts.age_min IS
  'Minimum viewer age (inclusive) when age_restriction_enabled = true.';
COMMENT ON COLUMN posts.age_max IS
  'Maximum viewer age (inclusive) when age_restriction_enabled = true.';
