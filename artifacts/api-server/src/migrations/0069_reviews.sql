-- 0069_reviews.sql
-- Cross-domain review system for trips and rent_buddy_bookings.
-- Entity types: trip, rent_buddy_booking
-- Visibility: public | anonymous
-- State:       published | hidden | removed

-- ── Type guards ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'review_entity_type'
  ) THEN
    CREATE TYPE review_entity_type AS ENUM ('trip', 'rent_buddy_booking');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'review_visibility'
  ) THEN
    CREATE TYPE review_visibility AS ENUM ('public', 'anonymous');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'review_state'
  ) THEN
    CREATE TYPE review_state AS ENUM ('published', 'hidden', 'removed');
  END IF;
END $$;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id   UUID              NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type   review_entity_type NOT NULL,
  entity_id     UUID              NOT NULL,
  rating        INTEGER           NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,
  tags          TEXT[]            NOT NULL DEFAULT '{}',
  visibility    review_visibility NOT NULL DEFAULT 'public',
  state         review_state      NOT NULL DEFAULT 'published',
  reported_by   UUID[]            NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id, reviewer_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS reviews_entity_idx
  ON reviews (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS reviews_reviewer_idx
  ON reviews (reviewer_id);

CREATE INDEX IF NOT EXISTS reviews_created_at_idx
  ON reviews (created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- Authors can read and update their own published/hidden reviews
DROP POLICY IF EXISTS "Authors can read own reviews" ON reviews;
CREATE POLICY "Authors can read own reviews"
  ON reviews FOR SELECT
  USING (reviewer_id = auth.uid());

DROP POLICY IF EXISTS "Authors can insert own reviews" ON reviews;
CREATE POLICY "Authors can insert own reviews"
  ON reviews FOR INSERT
  WITH CHECK (reviewer_id = auth.uid());

DROP POLICY IF EXISTS "Authors can update own reviews" ON reviews;
CREATE POLICY "Authors can update own reviews"
  ON reviews FOR UPDATE
  USING (reviewer_id = auth.uid() AND state != 'removed');

-- Public can read published non-anonymous reviews
DROP POLICY IF EXISTS "Public read published reviews" ON reviews;
CREATE POLICY "Public read published reviews"
  ON reviews FOR SELECT
  USING (state = 'published');

-- Service role has unrestricted access (bypasses RLS when using service key)
