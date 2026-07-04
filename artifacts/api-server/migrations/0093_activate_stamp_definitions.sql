-- Migration: 0093_activate_stamp_definitions
-- Activates 15 previously-inactive stamp definitions whose route-level
-- triggers are now wired in the API server.
--
-- Grouped by trigger source:
--   posts.ts       — first_post, storyteller, photographer
--   posts.ts (GPS) — city_explorer, globe_trotter, world_citizen
--   follows.ts     — community_connector, popular_traveler, travel_influencer
--   trips.ts       — trip_planner, good_host
--   rentABuddy.ts  — buddy_veteran, nightlife_guide, food_guide, top_rated_buddy
--   events.ts      — event_host, event_participant
--
-- Safe to re-run: WHERE is_active = false guard makes this idempotent.

UPDATE stamp_definitions
SET is_active = true
WHERE slug IN (
  -- Post milestone stamps (wired in routes/posts.ts)
  'first_post',
  'storyteller',
  'photographer',

  -- GPS location milestone stamps (wired in routes/posts.ts via location context)
  'city_explorer',
  'globe_trotter',
  'world_citizen',

  -- Follow / social reach stamps (wired in routes/follows.ts)
  'community_connector',
  'popular_traveler',
  'travel_influencer',

  -- Trip lifecycle stamps (wired in routes/trips.ts)
  'trip_planner',
  'good_host',

  -- Rent-a-buddy progression stamps (wired in routes/rentABuddy.ts)
  'buddy_veteran',
  'nightlife_guide',
  'food_guide',
  'top_rated_buddy',

  -- Event completion stamps (wired in routes/events.ts)
  'event_host',
  'event_participant'
)
AND is_active = false;
