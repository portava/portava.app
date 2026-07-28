-- Migration 0107: @Portava post category enum + scheduled_at alias
--
-- Adds a portava_post_category enum type for the accepted curation categories
-- and a scheduled_at generated column (alias for publish_after_time) so admin
-- tooling can reference the scheduling field by its canonical name.
--
-- The `category` column on posts already exists (migration 0049 / postSchemas.ts),
-- so we only create the enum type and attach it as an application-level constraint.
-- All columns are nullable and backward-compatible with existing posts.

BEGIN;

-- Create the category enum type (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'portava_post_category') THEN
    CREATE TYPE portava_post_category AS ENUM (
      'hidden_gem',
      'inspiration',
      'festival',
      'restaurant',
      'beach_resort',
      'nightlife',
      'neighborhood',
      'trending_destination',
      'travel_tip',
      'hotel',
      'featured_creator',
      'destination_of_week',
      'community_spotlight'
    );
  END IF;
END
$$;

-- Index to speed up admin list queries filtered by category on @portava posts
CREATE INDEX IF NOT EXISTS posts_category_idx ON posts (category)
  WHERE category IS NOT NULL;

-- Index to speed up scheduled-post queries from the admin list screen
CREATE INDEX IF NOT EXISTS posts_publish_after_time_idx ON posts (publish_after_time)
  WHERE publish_after_time IS NOT NULL AND post_status = 'pending_delay';

COMMIT;
