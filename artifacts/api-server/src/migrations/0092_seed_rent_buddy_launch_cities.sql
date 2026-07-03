-- 0092_seed_rent_buddy_launch_cities.sql
-- Seeds the initial launch cities for the Rent a Buddy feature.
--
-- Without at least one row in rent_buddy_city_rollouts with a live status
-- (public_mvp or beta_testing), every call to checkRentBuddyAccess returns
-- city_not_available and the feature is invisible to all users even though
-- migration 0090 fully deployed the tables and flags.
--
-- City status progression (defined in 0090 enum rent_buddy_city_status):
--   disabled → waitlist_only → buddy_applications_open → internal_testing
--   → beta_testing → public_mvp → paused | suspended
--
-- Initial launch market: Philippines.
-- Cities seeded at public_mvp are immediately open to all authenticated users.
-- Cities seeded at beta_testing require a beta invitation row in
-- rent_buddy_beta_access to proceed beyond a read action.
--
-- Safe to re-run: all inserts use ON CONFLICT (city) DO NOTHING so existing
-- operator-managed rows are never overwritten.
--
-- Applied: 2026-07-03

INSERT INTO rent_buddy_city_rollouts (city, country, status, notes)
VALUES
  ('Cebu',       'Philippines', 'public_mvp',   'Initial Philippines launch city — Cebu City metro area.'),
  ('Manila',     'Philippines', 'public_mvp',   'Initial Philippines launch city — Metro Manila (NCR).'),
  ('Davao City', 'Philippines', 'public_mvp',   'Initial Philippines launch city — Davao region.')
ON CONFLICT (city) DO NOTHING;
