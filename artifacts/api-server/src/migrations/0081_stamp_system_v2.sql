-- Migration: 0080_stamp_system_v2.sql
-- Adds the full Passport Stamps v2 data model:
--   stamp_definitions, user_stamps, stamp_award_events,
--   stamp_progress, stamp_collections, stamp_collection_items
-- Existing passport_stamps / stamps tables are NOT modified.

-- ─── stamp_definitions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_definitions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  description          text,
  stamp_type           text NOT NULL,   -- location | trip | event | social | safety | rent_buddy | special
  category             text NOT NULL,
  icon_url             text,
  rarity               text NOT NULL DEFAULT 'common',  -- common | uncommon | rare | legendary
  is_active            boolean NOT NULL DEFAULT false,
  is_repeatable        boolean NOT NULL DEFAULT false,
  max_awards_per_user  integer,                          -- null = unlimited (for repeatable stamps)
  level_config         jsonb,                            -- optional level thresholds for repeatable stamps
  criteria_type        text NOT NULL DEFAULT 'manual',   -- manual | automatic | admin_only
  criteria             jsonb,                            -- machine-readable eligibility criteria
  visibility_default   text NOT NULL DEFAULT 'public',   -- public | friends_only | private
  source_system        text,                             -- trips | posts | safe_return | rent_buddy | events
  city                 text,                             -- for geo-locked stamps
  country              text,                             -- for geo-locked stamps
  starts_at            timestamptz,
  ends_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stamp_definitions ENABLE ROW LEVEL SECURITY;

-- Everyone can read active definitions
CREATE POLICY "stamp_definitions_public_read" ON stamp_definitions
  FOR SELECT USING (is_active = true);

-- Admins read everything
CREATE POLICY "stamp_definitions_admin_all" ON stamp_definitions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── user_stamps ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_stamps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_definition_id  uuid NOT NULL REFERENCES stamp_definitions(id) ON DELETE RESTRICT,
  source_type          text,              -- trips | posts | safe_return | rent_buddy | events | admin
  source_id            uuid,              -- reference to the triggering entity
  earned_at            timestamptz NOT NULL DEFAULT now(),
  city                 text,
  country              text,
  lat                  numeric(10,7),     -- PRIVATE — never exposed in public queries
  lng                  numeric(10,7),     -- PRIVATE — never exposed in public queries
  title_override       text,             -- optional custom display title
  metadata             jsonb,
  visibility           text NOT NULL DEFAULT 'public',  -- public | friends_only | private
  display_on_passport  boolean NOT NULL DEFAULT true,
  is_revoked           boolean NOT NULL DEFAULT false,
  revoked_at           timestamptz,
  revoked_reason       text,
  awarded_by_admin_id  uuid REFERENCES profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_stamps ENABLE ROW LEVEL SECURITY;

-- Owner sees all own stamps (including revoked/private)
CREATE POLICY "user_stamps_owner_read" ON user_stamps
  FOR SELECT USING (auth.uid() = user_id);

-- Public reads: only non-revoked, public-visibility stamps; lat/lng excluded via SELECT column list
CREATE POLICY "user_stamps_public_read" ON user_stamps
  FOR SELECT USING (
    is_revoked = false
    AND visibility = 'public'
    AND auth.uid() != user_id
  );

-- Friends-only stamps visible to circle members
CREATE POLICY "user_stamps_friends_read" ON user_stamps
  FOR SELECT USING (
    is_revoked = false
    AND visibility = 'friends_only'
    AND auth.uid() != user_id
    AND EXISTS (
      SELECT 1 FROM user_friendships
       WHERE (
           (user_a = auth.uid() AND user_b = user_stamps.user_id)
           OR
           (user_b = auth.uid() AND user_a = user_stamps.user_id)
         )
    )
  );

-- ─── stamp_award_events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_award_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_definition_id  uuid NOT NULL REFERENCES stamp_definitions(id) ON DELETE RESTRICT,
  source_type          text,
  source_id            uuid,
  award_reason         text,
  criteria_snapshot    jsonb,
  idempotency_key      text NOT NULL UNIQUE,  -- sha of (user_id:def_id:source_type:source_id)
  status               text NOT NULL DEFAULT 'awarded',  -- awarded | revoked | restored
  admin_id             uuid REFERENCES profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stamp_award_events ENABLE ROW LEVEL SECURITY;

-- Owner sees own audit trail
CREATE POLICY "stamp_award_events_owner_read" ON stamp_award_events
  FOR SELECT USING (auth.uid() = user_id);

-- Admins read all
CREATE POLICY "stamp_award_events_admin_read" ON stamp_award_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── stamp_progress ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_progress (
  user_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_definition_id  uuid NOT NULL REFERENCES stamp_definitions(id) ON DELETE CASCADE,
  progress_count       integer NOT NULL DEFAULT 0,
  progress_target      integer,
  metadata             jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stamp_definition_id)
);

ALTER TABLE stamp_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stamp_progress_owner_read" ON stamp_progress
  FOR SELECT USING (auth.uid() = user_id);

-- ─── stamp_collections ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_collections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  description          text,
  icon_url             text,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stamp_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stamp_collections_public_read" ON stamp_collections
  FOR SELECT USING (is_active = true);

-- ─── stamp_collection_items ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_collection_items (
  collection_id        uuid NOT NULL REFERENCES stamp_collections(id) ON DELETE CASCADE,
  stamp_definition_id  uuid NOT NULL REFERENCES stamp_definitions(id) ON DELETE CASCADE,
  sort_order           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, stamp_definition_id)
);

ALTER TABLE stamp_collection_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stamp_collection_items_public_read" ON stamp_collection_items
  FOR SELECT USING (true);

-- ─── stamp_campaigns ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_campaigns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  description          text,
  stamp_definition_id  uuid REFERENCES stamp_definitions(id) ON DELETE SET NULL,
  starts_at            timestamptz,
  ends_at              timestamptz,
  is_active            boolean NOT NULL DEFAULT false,
  metadata             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stamp_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stamp_campaigns_public_read" ON stamp_campaigns
  FOR SELECT USING (is_active = true);

CREATE POLICY "stamp_campaigns_admin_all" ON stamp_campaigns
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS user_stamps_user_id_idx          ON user_stamps(user_id);
CREATE INDEX IF NOT EXISTS user_stamps_definition_idx       ON user_stamps(stamp_definition_id);
CREATE INDEX IF NOT EXISTS user_stamps_earned_at_idx        ON user_stamps(earned_at DESC);
CREATE INDEX IF NOT EXISTS user_stamps_city_idx             ON user_stamps(city) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_stamps_country_idx          ON user_stamps(country) WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS stamp_award_events_user_idx      ON stamp_award_events(user_id);
CREATE INDEX IF NOT EXISTS stamp_award_events_def_idx       ON stamp_award_events(stamp_definition_id);
CREATE INDEX IF NOT EXISTS stamp_progress_user_idx          ON stamp_progress(user_id);

-- ─── Feature flags ────────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('stamp_system_v2_enabled', false, 'Passport Stamps v2 — full award engine and catalog'),
  ('stamp_admin_award_enabled', false, 'Allow admins to manually award stamps')
ON CONFLICT (flag) DO NOTHING;

-- ─── Starter stamp catalog (~40 definitions) ─────────────────────────────────
-- is_active = false for any whose trigger system is not yet wired.
-- Trip/post/safe-return/rent-buddy triggers are wired in the next task.

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES

-- ── LOCATION stamps ──────────────────────────────────────────────────────────
('city_explorer',        'City Explorer',        'Visit your first city',                          'location', 'location',  'common',    false, false, 1,    'automatic', 'public', 'posts'),
('globe_trotter',        'Globe Trotter',        'Visit 5 different countries',                    'location', 'location',  'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),
('world_citizen',        'World Citizen',        'Visit 20 different countries',                   'location', 'location',  'rare',      false, false, 1,    'automatic', 'public', 'posts'),
('continent_hopper',     'Continent Hopper',     'Visit destinations on 3 continents',             'location', 'location',  'rare',      false, false, 1,    'automatic', 'public', 'posts'),
('neighborhood_local',   'Neighborhood Local',   'Check in to 5 neighborhoods in one city',        'location', 'location',  'common',    false, false, 1,    'automatic', 'public', 'posts'),
('hidden_gem_hunter',    'Hidden Gem Hunter',    'Discover 3 hidden gems',                         'location', 'location',  'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),
('night_owl',            'Night Owl',            'Post from a nightlife venue after midnight',     'location', 'location',  'common',    false, false, 1,    'automatic', 'public', 'posts'),
('sunrise_chaser',       'Sunrise Chaser',       'Post from an outdoor location before 7 AM',     'location', 'location',  'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),

-- ── TRIP stamps ──────────────────────────────────────────────────────────────
('first_trip',           'First Trip',           'Complete your first trip on Travel Buddy',       'trip',     'trip',      'common',    false, false, 1,    'automatic', 'public', 'trips'),
('solo_adventurer',      'Solo Adventurer',      'Complete a solo trip',                           'trip',     'trip',      'common',    false, false, 1,    'automatic', 'public', 'trips'),
('crew_captain',         'Crew Captain',         'Host a trip with 3 or more members',             'trip',     'trip',      'uncommon',  false, false, 1,    'automatic', 'public', 'trips'),
('road_warrior',         'Road Warrior',         'Complete 5 trips',                               'trip',     'trip',      'uncommon',  false, false, 1,    'automatic', 'public', 'trips'),
('frequent_flyer',       'Frequent Flyer',       'Complete 10 trips',                              'trip',     'trip',      'rare',      false, false, 1,    'automatic', 'public', 'trips'),
('long_haul',            'Long Haul',            'Complete a trip lasting more than 14 days',      'trip',     'trip',      'uncommon',  false, false, 1,    'automatic', 'public', 'trips'),
('weekend_warrior',      'Weekend Warrior',      'Complete a trip over a weekend',                 'trip',     'trip',      'common',    false, false, 1,    'automatic', 'public', 'trips'),
('international_voyager','International Voyager','Complete a trip to a new country',               'trip',     'trip',      'uncommon',  false, false, 1,    'automatic', 'public', 'trips'),

-- ── SOCIAL / COMMUNITY stamps ────────────────────────────────────────────────
('first_post',           'First Post',           'Share your first travel post',                   'social',   'community', 'common',    false, false, 1,    'automatic', 'public', 'posts'),
('storyteller',          'Storyteller',          'Share 10 travel posts',                          'social',   'community', 'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),
('photographer',         'Photographer',         'Share 25 posts with photos',                     'social',   'community', 'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),
('community_connector',  'Community Connector',  'Follow 10 other travelers',                      'social',   'community', 'common',    false, false, 1,    'automatic', 'public', 'posts'),
('popular_traveler',     'Popular Traveler',      'Reach 50 followers',                            'social',   'community', 'uncommon',  false, false, 1,    'automatic', 'public', 'posts'),
('travel_influencer',    'Travel Influencer',    'Reach 500 followers',                            'social',   'community', 'rare',      false, false, 1,    'automatic', 'public', 'posts'),
('trip_planner',         'Trip Planner',         'Create and publish a trip plan',                 'social',   'community', 'common',    false, false, 1,    'automatic', 'public', 'trips'),
('good_host',            'Good Host',            'Host a trip with all attendees rating 4+ stars', 'social',   'community', 'uncommon',  false, false, 1,    'automatic', 'public', 'trips'),

-- ── SAFETY / TRUST stamps ────────────────────────────────────────────────────
('safe_traveler',        'Safe Traveler',        'Complete your first safe return check-in',       'safety',   'safety',    'common',    false, false, 1,    'automatic', 'private', 'safe_return'),
('safety_advocate',      'Safety Advocate',      'Complete 5 safe return check-ins',               'safety',   'safety',    'uncommon',  false, false, 1,    'automatic', 'private', 'safe_return'),
('verified_identity',    'Verified Identity',    'Complete identity verification',                  'safety',   'trust',     'uncommon',  false, false, 1,    'manual',    'public',  NULL),
('trusted_member',       'Trusted Member',       'Reach Trusted Traveler trust level',             'safety',   'trust',     'rare',      false, false, 1,    'automatic', 'public',  NULL),
('city_trusted_member',  'City Trusted',         'Reach City Trusted trust level',                 'safety',   'trust',     'legendary', false, false, 1,    'automatic', 'public',  NULL),

-- ── RENT-A-BUDDY stamps ──────────────────────────────────────────────────────
('first_session',        'First Session',        'Complete your first Rent-a-Buddy session',       'rent_buddy','rent_buddy','common',   false, false, 1,    'automatic', 'public', 'rent_buddy'),
('buddy_veteran',        'Buddy Veteran',        'Complete 5 Rent-a-Buddy sessions',               'rent_buddy','rent_buddy','uncommon', false, false, 1,    'automatic', 'public', 'rent_buddy'),
('top_rated_buddy',      'Top Rated Buddy',      'Maintain a 4.8+ average rating as a buddy',      'rent_buddy','rent_buddy','rare',      false, false, 1,    'automatic', 'public', 'rent_buddy'),
('nightlife_guide',      'Nightlife Guide',      'Complete a nightlife Rent-a-Buddy session',      'rent_buddy','rent_buddy','common',    false, false, 1,    'automatic', 'public', 'rent_buddy'),
('food_guide',           'Food Guide',           'Complete a food & dining session',               'rent_buddy','rent_buddy','common',    false, false, 1,    'automatic', 'public', 'rent_buddy'),

-- ── SPECIAL / ADMIN stamps ───────────────────────────────────────────────────
('early_adopter',        'Early Adopter',        'Joined Travel Buddy during the beta period',     'special',  'special',   'legendary', false, false, 1,    'admin_only','public',  NULL),
('founding_member',      'Founding Member',      'One of the first 1000 members',                  'special',  'special',   'legendary', false, false, 1,    'admin_only','public',  NULL),
('ambassador',           'Ambassador',           'Nominated as an official Travel Buddy Ambassador','special', 'special',   'legendary', false, false, 1,    'admin_only','public',  NULL),
('event_participant',    'Event Participant',    'Participated in an official Travel Buddy event',  'event',    'event',     'uncommon',  false, false, NULL, 'automatic', 'public', 'events'),
('event_host',           'Event Host',           'Hosted an official Travel Buddy event',           'event',    'event',     'rare',      false, false, NULL, 'automatic', 'public', 'events'),
('beta_tester',          'Beta Tester',          'Participated in the Travel Buddy beta program',   'special',  'special',   'rare',      false, false, 1,    'admin_only','public',  NULL)

ON CONFLICT (slug) DO NOTHING;

-- ─── Starter collections ─────────────────────────────────────────────────────

INSERT INTO stamp_collections (slug, name, description) VALUES
  ('explorer',    'Explorer Set',       'Stamps for discovering new places and cities'),
  ('social',      'Social Set',         'Stamps for building community and connections'),
  ('safety',      'Safety Set',         'Stamps for safety-conscious travel'),
  ('rent_buddy',  'Rent-a-Buddy Set',   'Stamps earned through Rent-a-Buddy sessions'),
  ('special',     'Special Edition',    'Limited and admin-awarded stamps')
ON CONFLICT (slug) DO NOTHING;
