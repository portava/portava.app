-- 0160: persist fields the client collects but the backend previously dropped.
-- Everything is idempotent (IF EXISTS / IF NOT EXISTS) and additive-only.

-- Decline reason (the decline route already writes this column — it was
-- failing silently because the column never existed).
ALTER TABLE IF EXISTS rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS decline_reason text;

-- Waitlist extras collected by the join form.
ALTER TABLE IF EXISTS rent_buddy_waitlist
  ADD COLUMN IF NOT EXISTS desired_date text,
  ADD COLUMN IF NOT EXISTS desired_time text,
  ADD COLUMN IF NOT EXISTS budget_usd numeric(8,2),
  ADD COLUMN IF NOT EXISTS notes text;

-- Package editor fields (included stops + meetup rules).
ALTER TABLE IF EXISTS rent_buddy_packages
  ADD COLUMN IF NOT EXISTS stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS meetup_rules text;
ALTER TABLE IF EXISTS buddy_packages
  ADD COLUMN IF NOT EXISTS stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS meetup_rules text;

-- Per-category star ratings on reviews (public-safe; note is NOT stored here).
ALTER TABLE IF EXISTS rent_buddy_reviews
  ADD COLUMN IF NOT EXISTS category_ratings jsonb;

-- Private safety notes live in their OWN table so the public review reads
-- (which select("*") with is_public=true) can never leak them.
CREATE TABLE IF NOT EXISTS rent_buddy_review_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid REFERENCES rent_buddy_reviews(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL,
  author_id   uuid NOT NULL,
  note        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rent_buddy_review_notes ENABLE ROW LEVEL SECURITY;
-- No RLS policies on purpose: service-role/admin access only.
