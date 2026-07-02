-- 0084_reviews_place_entity.sql
-- Extends the reviews system to support seeded/community place ratings.
--
-- Changes:
--   1. Adds 'place' to the review_entity_type enum
--   2. RLS: any authenticated user may insert/select/update/delete their own
--      place reviews (no trip-membership check — place rating is open to all).

-- ── Extend enum ───────────────────────────────────────────────────────────────
-- PostgreSQL requires ALTER TYPE … ADD VALUE to run outside a transaction.
-- The DO block checks existence so the migration is idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'place'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'review_entity_type')
  ) THEN
    ALTER TYPE review_entity_type ADD VALUE 'place';
  END IF;
END $$;

-- ── RLS additions for place entity_type ──────────────────────────────────────
-- The existing policies already cover INSERT (reviewer_id = auth.uid()) and
-- SELECT (state = 'published'). We add explicit named policies for clarity and
-- to cover the DELETE case for place reviews.

DROP POLICY IF EXISTS "Authors can delete own place reviews" ON reviews;
CREATE POLICY "Authors can delete own place reviews"
  ON reviews FOR DELETE
  USING (reviewer_id = auth.uid() AND entity_type = 'place'::review_entity_type);

-- Ensure there is a unique constraint per reviewer per place
-- (the table already has UNIQUE (entity_type, entity_id, reviewer_id)).
