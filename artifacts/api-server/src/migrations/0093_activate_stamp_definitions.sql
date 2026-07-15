-- Migration: 0093_activate_stamp_definitions.sql
-- Activates stamp definitions whose route-level triggers are now wired.
--
-- TRIGGERS WIRED (per route file):
--   posts.ts      — first_post, storyteller, photographer (post count)
--                   city_explorer, globe_trotter, world_citizen (location milestones)
--   follows.ts    — community_connector (following count ≥10)
--                   popular_traveler (follower count ≥50)
--                   travel_influencer (follower count ≥500)
--   trips.ts      — trip_planner (trip created + published)
--                   good_host (trip completed with ≥2 members)
--   rentABuddy.ts — buddy_veteran (5+ completed sessions)
--                   nightlife_guide (completed nightlife session)
--                   food_guide (completed food/dining session)
--                   top_rated_buddy (average_rating ≥4.8, ≥3 reviews)
--   events.ts     — event_host (host marks event completed)
--                   event_participant (checked-in attendee at completed event)
--
-- NOT activated here (no trigger wired yet):
--   continent_hopper — requires continent mapping not in current schema
--   neighborhood_local, hidden_gem_hunter, night_owl, sunrise_chaser — location variants,
--     no trigger defined in this batch
--   trusted_member, city_trusted_member — trust-level stamps, separate trigger required
--
-- Safe to re-run: WHERE is_active = false guard makes it idempotent.

-- ─── Post count / social stamps ───────────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'first_post',           -- 1st published post
         'storyteller',          -- 10 published posts
         'photographer'          -- 25 posts with photos
       )
  AND  is_active = false;

-- ─── Location milestone stamps ─────────────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'city_explorer',        -- First GPS-verified city visit
         'globe_trotter',        -- 5 distinct countries
         'world_citizen'         -- 20 distinct countries
       )
  AND  is_active = false;

-- ─── Social follow-count stamps ────────────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'community_connector',  -- Following 10+ travelers
         'popular_traveler',     -- 50+ followers
         'travel_influencer'     -- 500+ followers
       )
  AND  is_active = false;

-- ─── Trip outcome stamps ───────────────────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'trip_planner',         -- Created and published a trip plan
         'good_host'             -- Hosted a trip that completed with ≥2 participants
       )
  AND  is_active = false;

-- ─── Rent-a-Buddy progression stamps ──────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'buddy_veteran',        -- 5+ completed Rent-a-Buddy sessions
         'nightlife_guide',      -- Completed a nightlife session
         'food_guide',           -- Completed a food & dining session
         'top_rated_buddy'       -- Average rating ≥4.8 with ≥3 reviews
       )
  AND  is_active = false;

-- ─── Event stamps ─────────────────────────────────────────────────────────────
UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'event_host',           -- Hosted and completed an official event
         'event_participant'     -- Checked in at a completed event
       )
  AND  is_active = false;
