-- Add photos column to reviews table
-- Stores up to 3 photo URLs attached to a review (images only, per the 'review' media policy).

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';
