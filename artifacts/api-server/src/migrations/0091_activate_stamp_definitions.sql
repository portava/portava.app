-- Migration: 0091_activate_stamp_definitions.sql
-- Activates the beta-launch subset of stamp definitions seeded (inactive) by 0081.
--
-- ACTIVATION CRITERIA:
--   A definition is activated here only when EITHER:
--   (a) its award trigger is fully wired in server-side route code, OR
--   (b) its criteria_type is 'admin_only' (no automatic trigger required).
--
-- NOT activated here (remain is_active = false):
--   • Definitions superseded by cleaner v2 slugs added in 0082
--     (first_trip, solo_adventurer, crew_captain, weekend_warrior,
--      safe_traveler, safety_advocate, verified_identity, first_session).
--   • Automatic definitions whose triggers are not yet wired:
--     location stamps (city_explorer, globe_trotter, world_citizen,
--       continent_hopper, neighborhood_local, hidden_gem_hunter,
--       night_owl, sunrise_chaser),
--     social count stamps (first_post, storyteller, photographer,
--       community_connector, popular_traveler, travel_influencer),
--     trip-outcome stamps (trip_planner, good_host),
--     trust-level stamps (trusted_member, city_trusted_member),
--     rent-a-buddy progression (buddy_veteran, top_rated_buddy,
--       nightlife_guide, food_guide),
--     event stamps (event_participant, event_host).
--
-- Safe to re-run: WHERE is_active = false guard makes it idempotent.

-- ─── Admin-only special stamps (beta engagement) ──────────────────────────────
-- These are awarded exclusively via POST /api/admin/stamps/award.
-- No automatic trigger is required; the admin award endpoint is live.

UPDATE stamp_definitions
SET    is_active  = true,
       updated_at = now()
WHERE  slug IN (
         'early_adopter',    -- Joined during the beta period
         'founding_member',  -- One of the first 1000 members
         'ambassador',       -- Nominated as an official Ambassador
         'beta_tester'       -- Participated in the beta program
       )
  AND  is_active = false;
