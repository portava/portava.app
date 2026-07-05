-- Migration 0114: Add moderation_status to rent_buddy_reviews
-- Reviews start at pending_moderation; admin approve sets is_public=true + approved;
-- admin reject sets is_public=false + rejected. Only approved reviews count toward
-- average_rating and review_count on rent_buddy_profiles.

ALTER TABLE rent_buddy_reviews
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending_moderation'
    CHECK (moderation_status IN ('pending_moderation', 'approved', 'rejected', 'auto_approved'));

-- Index for admin moderation queue
CREATE INDEX IF NOT EXISTS idx_rent_buddy_reviews_moderation_status
  ON rent_buddy_reviews (moderation_status, created_at DESC);

-- Backfill: existing public reviews (is_public=true) that were unblinded by the
-- double-blind mechanism are treated as auto_approved so they remain visible.
UPDATE rent_buddy_reviews
  SET moderation_status = 'auto_approved'
  WHERE is_public = TRUE AND moderation_status = 'pending_moderation';
