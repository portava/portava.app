-- Migration 0069: Cross-domain post-attendance reviews
-- Covers reviews for trips and rent_buddy_bookings (events already have event_reviews from 0065)
-- NOT applied automatically — run in Supabase SQL Editor

-- ── Entity type & visibility enums ────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE review_entity_type AS ENUM ('event', 'trip', 'rent_buddy_booking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_visibility AS ENUM ('public', 'anonymous');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_state AS ENUM ('published', 'hidden', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── reviews ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type     review_entity_type NOT NULL,
  entity_id       UUID NOT NULL,
  rating          SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  body            TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  visibility      review_visibility NOT NULL DEFAULT 'public',
  state           review_state NOT NULL DEFAULT 'published',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One review per reviewer per entity
CREATE UNIQUE INDEX IF NOT EXISTS reviews_reviewer_entity_idx
  ON reviews (reviewer_id, entity_type, entity_id);

-- Lookup by entity (for review list on event/trip/booking detail)
CREATE INDEX IF NOT EXISTS reviews_entity_idx
  ON reviews (entity_type, entity_id, created_at DESC);

-- Lookup by reviewer (for profile host reviews)
CREATE INDEX IF NOT EXISTS reviews_reviewer_idx
  ON reviews (reviewer_id, created_at DESC);

-- Partial index for published+public reviews (hottest read path)
CREATE INDEX IF NOT EXISTS reviews_published_public_idx
  ON reviews (entity_type, entity_id)
  WHERE state = 'published' AND visibility = 'public';

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reviewers read own reviews" ON reviews;
CREATE POLICY "Reviewers read own reviews"
  ON reviews FOR SELECT
  USING (reviewer_id = auth.uid());

DROP POLICY IF EXISTS "Public reads published public reviews" ON reviews;
CREATE POLICY "Public reads published public reviews"
  ON reviews FOR SELECT
  USING (state = 'published' AND visibility = 'public');

DROP POLICY IF EXISTS "Reviewers insert own reviews" ON reviews;
CREATE POLICY "Reviewers insert own reviews"
  ON reviews FOR INSERT
  WITH CHECK (reviewer_id = auth.uid());

DROP POLICY IF EXISTS "Reviewers update own published reviews" ON reviews;
CREATE POLICY "Reviewers update own published reviews"
  ON reviews FOR UPDATE
  USING (reviewer_id = auth.uid() AND state = 'published');

-- Service role handles admin removal/hide (no explicit policy needed — bypasses RLS)
