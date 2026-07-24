-- Migration 0179: Stamp Wave 3 — criteria engine
--
-- Makes the long-dormant stamp_definitions.criteria jsonb column live:
-- versioned rules the criteria engine evaluates, so unlock thresholds become
-- DATA instead of ~30 hard-coded award sites.
--
-- Flag-gated (stamp_criteria_engine_enabled, default FALSE). While off, the
-- hard-coded award sites remain the sole authority and these criteria are
-- inert. While on, the criteria act as an ADDITIVE gate on award + power the
-- data-driven evaluate/award path. Overlap with hard-coded sites is harmless:
-- awardStamp dedupes on (user:def:source).
--
-- Safe to re-run.

-- ── Flag ─────────────────────────────────────────────────────────────────────
-- feature_flags PK column is `flag` (NOT `key`).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('stamp_criteria_engine_enabled', FALSE,
   'Stamp criteria engine: evaluate stamp_definitions.criteria (data-driven unlocks) as an additive award gate + evaluate/award path')
ON CONFLICT (flag) DO NOTHING;

-- ── Seed criteria onto existing social/trip milestone definitions ────────────
-- These mirror the current hard-coded thresholds exactly, so enabling the
-- engine changes nothing about WHEN they unlock — it just moves the rule into
-- data. (The hard-coded sites keep working regardless; this proves parity.)
-- Only sets criteria where the definition exists and criteria is still null.

UPDATE stamp_definitions SET criteria = '{"version":1,"all":[{"metric":"following_count","gte":10}]}'::jsonb
  WHERE slug = 'community_connector' AND criteria IS NULL;

UPDATE stamp_definitions SET criteria = '{"version":1,"all":[{"metric":"followers_count","gte":50}]}'::jsonb
  WHERE slug = 'popular_traveler' AND criteria IS NULL;

UPDATE stamp_definitions SET criteria = '{"version":1,"all":[{"metric":"followers_count","gte":500}]}'::jsonb
  WHERE slug = 'travel_influencer' AND criteria IS NULL;

UPDATE stamp_definitions SET criteria = '{"version":1,"all":[{"metric":"trips_completed","gte":5}]}'::jsonb
  WHERE slug = 'road_warrior' AND criteria IS NULL;

UPDATE stamp_definitions SET criteria = '{"version":1,"all":[{"metric":"trips_completed","gte":10}]}'::jsonb
  WHERE slug = 'frequent_flyer' AND criteria IS NULL;

-- ── Event-category stamp definitions (net-new; NL from the audit's Task #1041) ─
-- criteria_type='automatic' + authored criteria → the evaluate/award path can
-- grant these with NO new hard-coded site. Context metrics event_category_*
-- and events_joined are supplied by the RSVP/complete trigger context.
-- is_active=FALSE for now: they light up only when you flip them active AND
-- enable the engine flag (double safety).

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, criteria, visibility_default, source_system)
VALUES
  ('foodie_explorer', 'Foodie Explorer', 'Join a food & drink event',
   'event', 'event', 'common', FALSE, false, 1, 'automatic',
   '{"version":1,"all":[{"metric":"event_category_food","is":true},{"metric":"events_joined","gte":1}]}'::jsonb,
   'public', 'events'),
  ('music_lover', 'Music Lover', 'Join a music event',
   'event', 'event', 'common', FALSE, false, 1, 'automatic',
   '{"version":1,"all":[{"metric":"event_category_music","is":true},{"metric":"events_joined","gte":1}]}'::jsonb,
   'public', 'events'),
  ('outdoor_adventurer', 'Outdoor Adventurer', 'Join an outdoor event',
   'event', 'event', 'common', FALSE, false, 1, 'automatic',
   '{"version":1,"all":[{"metric":"event_category_outdoor","is":true},{"metric":"events_joined","gte":1}]}'::jsonb,
   'public', 'events'),
  ('event_regular', 'Event Regular', 'Join 5 events',
   'event', 'event', 'uncommon', FALSE, false, 1, 'automatic',
   '{"version":1,"all":[{"metric":"events_joined","gte":5}]}'::jsonb,
   'public', 'events')
ON CONFLICT (slug) DO NOTHING;
