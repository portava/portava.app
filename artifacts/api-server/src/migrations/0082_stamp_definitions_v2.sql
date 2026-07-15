-- Migration: 0082_stamp_definitions_v2.sql
-- Inserts the 12 stamp_definitions rows whose triggers were wired in Task #1048
-- (trips, posts, safeReturn, rentABuddy, hiddenGems, admin-verify routes).
-- Also activates 4 existing rows whose triggers are now live.
--
-- Safe to re-run: all INSERTs use ON CONFLICT (slug) DO NOTHING.
-- UPDATE statements use WHERE is_active = false so they are also idempotent.

-- ─── New rows: trip lifecycle ─────────────────────────────────────────────────

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('first_trip_created',
   'First Step',
   'Create your first trip on Travel Buddy',
   'trip', 'trip', 'common', true, false, 1, 'automatic', 'public', 'trips'),

  ('first_trip_completed',
   'First Journey Complete',
   'Complete your first trip on Travel Buddy',
   'trip', 'trip', 'common', true, false, 1, 'automatic', 'public', 'trips'),

  ('solo_traveler',
   'Solo Traveler',
   'Complete a solo trip',
   'trip', 'trip', 'common', true, false, 1, 'automatic', 'public', 'trips'),

  ('group_tripper',
   'Group Tripper',
   'Host a trip with 3 or more members',
   'trip', 'trip', 'uncommon', true, false, 1, 'automatic', 'public', 'trips'),

  ('weekend_wanderer',
   'Weekend Wanderer',
   'Complete a trip over a weekend',
   'trip', 'trip', 'common', true, false, 1, 'automatic', 'public', 'trips')

ON CONFLICT (slug) DO NOTHING;

-- ─── Activate existing trip-completion rows (triggers now wired) ──────────────

UPDATE stamp_definitions SET is_active = true, updated_at = now()
WHERE slug IN ('road_warrior', 'frequent_flyer', 'long_haul', 'international_voyager')
  AND is_active = false;

-- ─── New rows: posts ──────────────────────────────────────────────────────────

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('first_postcard',
   'First Postcard',
   'Share your first passport postcard',
   'social', 'community', 'common', true, false, 1, 'automatic', 'public', 'posts')

ON CONFLICT (slug) DO NOTHING;

-- ─── New rows: Safe Return ────────────────────────────────────────────────────

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('safe_return_ready',
   'Safety First',
   'Activated Safe Return for a trip',
   'safety', 'safety', 'common', true, false, 1, 'automatic', 'private', 'safe_return'),

  ('safe_return_completed',
   'Safe and Sound',
   'Completed a Safe Return check-in',
   'safety', 'safety', 'uncommon', true, false, 1, 'automatic', 'private', 'safe_return')

ON CONFLICT (slug) DO NOTHING;

-- ─── New rows: Rent-a-Buddy ───────────────────────────────────────────────────

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('first_buddy_booking',
   'First Buddy Booked',
   'Completed your first Rent-a-Buddy booking as a traveler',
   'rent_buddy', 'rent_buddy', 'common', true, false, 1, 'automatic', 'public', 'rent_buddy'),

  ('first_buddy_hosted',
   'First Buddy Session',
   'Completed your first hosted Rent-a-Buddy session as a buddy',
   'rent_buddy', 'rent_buddy', 'common', true, false, 1, 'automatic', 'public', 'rent_buddy')

ON CONFLICT (slug) DO NOTHING;

-- ─── New rows: Hidden Gems & Admin ───────────────────────────────────────────

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('hidden_gem_explorer',
   'Hidden Gem Explorer',
   'Discovered and shared an approved hidden gem',
   'special', 'special', 'uncommon', true, false, 1, 'automatic', 'public', NULL),

  ('verified_traveler',
   'Verified Traveler',
   'Completed identity verification',
   'safety', 'trust', 'uncommon', true, false, 1, 'automatic', 'public', NULL)

ON CONFLICT (slug) DO NOTHING;
