-- Migration: meetups + availability
-- Apply via the Supabase SQL Editor (DNS to db.*.supabase.co is blocked from Replit).
-- All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards so re-running is safe.

-- ============================================================
-- PATCH: trip_plan_items — add columns used by the API but
-- missing from migration 0010 (GPS coords + privacy flag)
-- ============================================================

ALTER TABLE trip_plan_items
  ADD COLUMN IF NOT EXISTS lat              double precision NULL,
  ADD COLUMN IF NOT EXISTS lng              double precision NULL,
  ADD COLUMN IF NOT EXISTS location_is_private boolean NOT NULL DEFAULT false;

-- ============================================================
-- MEETUPS
-- ============================================================

CREATE TABLE IF NOT EXISTS meetups (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            text        NOT NULL,
  description      text        NULL,
  location_name    text        NULL,
  approximate_date date        NULL,
  time_block       text        NULL,
  -- 'morning' | 'afternoon' | 'evening' | 'late'
  starts_at        timestamptz NULL,
  ends_at          timestamptz NULL,
  status           text        NOT NULL DEFAULT 'active',
  -- 'draft' | 'active' | 'confirmed' | 'cancelled'
  trip_id          uuid        NULL REFERENCES trips(id) ON DELETE SET NULL,
  circle_owner_id  uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  visibility       text        NOT NULL DEFAULT 'invitees',
  -- 'invitees' | 'trip' | 'circle' | 'friends'
  chat_thread_id   uuid        NULL,
  -- soft ref to message_threads.id — set after thread is resolved
  chat_message_id  uuid        NULL,
  -- soft ref to messages.id — the system card in the thread
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meetups ENABLE ROW LEVEL SECURITY;

-- Creators can do everything with their meetups
CREATE POLICY "meetups_creator_all" ON meetups
  FOR ALL USING (creator_id = auth.uid());

-- Direct invitees can read the meetup
CREATE POLICY "meetups_invitee_select" ON meetups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meetup_invites mi
      WHERE mi.meetup_id = meetups.id
        AND mi.user_id   = auth.uid()
    )
  );

-- Accepted trip members can read trip-scoped meetups
CREATE POLICY "meetups_trip_member_select" ON meetups
  FOR SELECT USING (
    visibility = 'trip'
    AND trip_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = meetups.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- ============================================================
-- MEETUP INVITES  (also serves as the RSVP record)
-- ============================================================

CREATE TABLE IF NOT EXISTS meetup_invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meetup_id   uuid        NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'pending',
  -- 'pending' | 'going' | 'maybe' | 'declined' | 'cancelled'
  invited_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meetup_id, user_id)
);

ALTER TABLE meetup_invites ENABLE ROW LEVEL SECURITY;

-- Invitee can see and update their own invite row (RSVP)
CREATE POLICY "meetup_invites_invitee_all" ON meetup_invites
  FOR ALL USING (user_id = auth.uid());

-- Creator can see all invites for their meetup (for counts)
CREATE POLICY "meetup_invites_creator_select" ON meetup_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meetups m
      WHERE m.id         = meetup_invites.meetup_id
        AND m.creator_id = auth.uid()
    )
  );

-- ============================================================
-- MEETUP TIME OPTIONS (proposed date/time slots)
-- ============================================================

CREATE TABLE IF NOT EXISTS meetup_time_options (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meetup_id     uuid        NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  proposed_date date        NOT NULL,
  time_block    text        NULL,
  -- 'morning' | 'afternoon' | 'evening' | 'late'
  label         text        NULL,
  confirmed     boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meetup_time_options ENABLE ROW LEVEL SECURITY;

-- Creator can manage time options for their meetup
CREATE POLICY "meetup_time_options_creator_all" ON meetup_time_options
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM meetups m
      WHERE m.id         = meetup_time_options.meetup_id
        AND m.creator_id = auth.uid()
    )
  );

-- Invitees can read time options to vote
CREATE POLICY "meetup_time_options_invitee_select" ON meetup_time_options
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meetup_invites mi
      WHERE mi.meetup_id = meetup_time_options.meetup_id
        AND mi.user_id   = auth.uid()
    )
  );

-- ============================================================
-- MEETUP TIME VOTES
-- ============================================================

CREATE TABLE IF NOT EXISTS meetup_time_votes (
  option_id  uuid        NOT NULL REFERENCES meetup_time_options(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vote       text        NOT NULL,
  -- 'yes' | 'maybe' | 'no'
  voted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);

ALTER TABLE meetup_time_votes ENABLE ROW LEVEL SECURITY;

-- Users can manage their own votes
CREATE POLICY "meetup_time_votes_own_all" ON meetup_time_votes
  FOR ALL USING (user_id = auth.uid());

-- Creator can read all votes for their meetup's options (for tallying)
CREATE POLICY "meetup_time_votes_creator_select" ON meetup_time_votes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM meetup_time_options mto
      JOIN meetups m ON m.id = mto.meetup_id
      WHERE mto.id       = meetup_time_votes.option_id
        AND m.creator_id = auth.uid()
    )
  );

-- ============================================================
-- USER AVAILABILITY (weekly grid per user)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_availability (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  weekly_days  jsonb       NOT NULL DEFAULT '{}',
  -- { "mon": ["morning","evening"], "fri": ["afternoon"] }
  open_to_meet boolean     NOT NULL DEFAULT false,
  strict_mode  boolean     NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_availability ENABLE ROW LEVEL SECURITY;

-- Users can read and write their own availability
CREATE POLICY "user_availability_own_all" ON user_availability
  FOR ALL USING (user_id = auth.uid());

-- Accepted friends can read others' availability
CREATE POLICY "user_availability_friends_select" ON user_availability
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_friendships uf
      WHERE (uf.user_a = auth.uid() AND uf.user_b = user_availability.user_id)
         OR (uf.user_b = auth.uid() AND uf.user_a = user_availability.user_id)
    )
  );

-- ============================================================
-- QUICK AVAILABILITY STATUS (ephemeral, expires)
-- ============================================================

CREATE TABLE IF NOT EXISTS quick_availability_status (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status     text        NOT NULL,
  -- 'free_now' | 'busy' | 'open_to_plans' | 'free_tonight'
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quick_availability_status ENABLE ROW LEVEL SECURITY;

-- Users can read and write their own quick status
CREATE POLICY "quick_av_own_all" ON quick_availability_status
  FOR ALL USING (user_id = auth.uid());

-- Accepted friends can read non-expired quick statuses
CREATE POLICY "quick_av_friends_select" ON quick_availability_status
  FOR SELECT USING (
    expires_at > now()
    AND EXISTS (
      SELECT 1 FROM user_friendships uf
      WHERE (uf.user_a = auth.uid() AND uf.user_b = quick_availability_status.user_id)
         OR (uf.user_b = auth.uid() AND uf.user_a = quick_availability_status.user_id)
    )
  );

-- ============================================================
-- TRIP AVAILABILITY (trip-scoped open days per member)
-- ============================================================

CREATE TABLE IF NOT EXISTS trip_availability (
  trip_id    uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  open_days  jsonb       NOT NULL DEFAULT '{}',
  -- { "2025-07-04": ["morning","evening"], ... }
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

ALTER TABLE trip_availability ENABLE ROW LEVEL SECURITY;

-- Accepted trip members can read all trip availability rows
CREATE POLICY "trip_availability_members_select" ON trip_availability
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = trip_availability.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Users can only write their own trip availability row
CREATE POLICY "trip_availability_own_write" ON trip_availability
  FOR ALL USING (user_id = auth.uid());
