-- ============================================================================
-- Travel Buddy — Migration 0013
-- Availability + Meetup Planning
--
-- Tables created:
--   user_availability         — general weekly grid + open_to_meet per user
--   quick_availability_status — ephemeral free-now / busy / open_to_plans
--   meetups                   — meetup entities (trip/circle/friends scoped)
--   meetup_invites            — per-user RSVP rows
--   meetup_time_options       — organizer-proposed time slots
--   meetup_time_votes         — per-user votes on time slots
--
-- trip_plan_items already created in 0010_trip_plan.sql / 0011_trip_plan_coords.sql
--
-- HARD RULES:
--   * No exact GPS on meetups — location_name text only.
--   * All user_id columns are set server-side; client-supplied values ignored.
--   * RLS gates every row: visibility is enforced at the DB level AND the API level.
--   * No service-role leakage fields exposed through API.
-- ============================================================================

-- ============================================================================
-- user_availability
-- One row per user. Stores the weekly time-block grid + open_to_meet flag.
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_availability (
  user_id         UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  weekly_days     JSONB NOT NULL DEFAULT '{}',
  -- e.g. {"mon": ["morning","evening"], "fri": ["evening","late"]}
  open_to_meet    BOOLEAN NOT NULL DEFAULT false,
  strict_mode     BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_availability ENABLE ROW LEVEL SECURITY;

-- Users can always read/write their own row
DROP POLICY IF EXISTS ua_own ON user_availability;
CREATE POLICY ua_own ON user_availability FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Friends can read each other's availability
DROP POLICY IF EXISTS ua_friends_select ON user_availability;
CREATE POLICY ua_friends_select ON user_availability FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_friendships
      WHERE (user_a = auth.uid() AND user_b = user_availability.user_id)
         OR (user_b = auth.uid() AND user_a = user_availability.user_id)
    )
  );

-- Circle members can read the circle owner's availability
DROP POLICY IF EXISTS ua_circle_select ON user_availability;
CREATE POLICY ua_circle_select ON user_availability FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM circle_memberships
      WHERE (owner_id = user_availability.user_id AND member_id = auth.uid())
         OR (member_id = user_availability.user_id AND owner_id = auth.uid())
    )
  );

-- Accepted trip members can read fellow members' availability
DROP POLICY IF EXISTS ua_trip_select ON user_availability;
CREATE POLICY ua_trip_select ON user_availability FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM trip_members tm1
      JOIN trip_members tm2 ON tm1.trip_id = tm2.trip_id
      WHERE tm1.user_id = auth.uid()
        AND tm1.role IN ('owner', 'member')
        AND tm2.user_id = user_availability.user_id
        AND tm2.role IN ('owner', 'member')
    )
  );

-- ============================================================================
-- quick_availability_status
-- Ephemeral status: free_now / busy / open_to_plans — expires automatically.
-- ============================================================================
CREATE TABLE IF NOT EXISTS quick_availability_status (
  user_id    UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('free_now', 'busy', 'open_to_plans', 'free_tonight')),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE quick_availability_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qas_own ON quick_availability_status;
CREATE POLICY qas_own ON quick_availability_status FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Friends can see quick status
DROP POLICY IF EXISTS qas_friends_select ON quick_availability_status;
CREATE POLICY qas_friends_select ON quick_availability_status FOR SELECT
  USING (
    expires_at > now()
    AND EXISTS (
      SELECT 1 FROM user_friendships
      WHERE (user_a = auth.uid() AND user_b = quick_availability_status.user_id)
         OR (user_b = auth.uid() AND user_a = quick_availability_status.user_id)
    )
  );

-- Circle members can see quick status
DROP POLICY IF EXISTS qas_circle_select ON quick_availability_status;
CREATE POLICY qas_circle_select ON quick_availability_status FOR SELECT
  USING (
    expires_at > now()
    AND EXISTS (
      SELECT 1 FROM circle_memberships
      WHERE (owner_id = quick_availability_status.user_id AND member_id = auth.uid())
         OR (member_id = quick_availability_status.user_id AND owner_id = auth.uid())
    )
  );

-- Trip members can see quick status
DROP POLICY IF EXISTS qas_trip_select ON quick_availability_status;
CREATE POLICY qas_trip_select ON quick_availability_status FOR SELECT
  USING (
    expires_at > now()
    AND EXISTS (
      SELECT 1 FROM trip_members tm1
      JOIN trip_members tm2 ON tm1.trip_id = tm2.trip_id
      WHERE tm1.user_id = auth.uid()
        AND tm1.role IN ('owner', 'member')
        AND tm2.user_id = quick_availability_status.user_id
        AND tm2.role IN ('owner', 'member')
    )
  );

-- ============================================================================
-- meetups
-- A meetup is tied to either a trip or a circle (or just a set of invited users).
-- No exact GPS — location_name is text only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS meetups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 200),
  description     TEXT,
  location_name   TEXT CHECK (length(location_name) <= 300),
  -- no lat/lng — privacy requirement
  approximate_date DATE,        -- nullable until confirmed
  time_block      TEXT CHECK (time_block IN ('morning','afternoon','evening','late')),
  starts_at       TIMESTAMPTZ,  -- set once time is confirmed
  ends_at         TIMESTAMPTZ,  -- optional end time
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','confirmed','cancelled')),
  -- scope
  trip_id         UUID REFERENCES trips(id) ON DELETE SET NULL,
  circle_owner_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  visibility      TEXT NOT NULL DEFAULT 'invitees'
                  CHECK (visibility IN ('invitees','trip','circle','friends')),
  -- chat linkage — the system message ID posted when meetup was created
  chat_thread_id  UUID REFERENCES message_threads(id) ON DELETE SET NULL,
  chat_message_id UUID,  -- soft ref to messages.id (no FK to avoid cascade issues)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meetups_creator   ON meetups(creator_id);
CREATE INDEX IF NOT EXISTS idx_meetups_trip       ON meetups(trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meetups_circle     ON meetups(circle_owner_id) WHERE circle_owner_id IS NOT NULL;

ALTER TABLE meetups ENABLE ROW LEVEL SECURITY;

-- Creator can do everything
DROP POLICY IF EXISTS meetups_creator ON meetups;
CREATE POLICY meetups_creator ON meetups FOR ALL
  USING (auth.uid() = creator_id)
  WITH CHECK (auth.uid() = creator_id);

-- Direct invitees can see the meetup
DROP POLICY IF EXISTS meetups_invitee_select ON meetups;
CREATE POLICY meetups_invitee_select ON meetups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetup_invites
      WHERE meetup_id = meetups.id AND user_id = auth.uid()
    )
  );

-- Trip members can see trip-scoped meetups
DROP POLICY IF EXISTS meetups_trip_select ON meetups;
CREATE POLICY meetups_trip_select ON meetups FOR SELECT
  USING (
    meetups.visibility = 'trip'
    AND meetups.trip_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_id = meetups.trip_id
        AND user_id = auth.uid()
        AND role IN ('owner', 'member')
    )
  );

-- Circle members can see circle-scoped meetups
DROP POLICY IF EXISTS meetups_circle_select ON meetups;
CREATE POLICY meetups_circle_select ON meetups FOR SELECT
  USING (
    meetups.visibility = 'circle'
    AND meetups.circle_owner_id IS NOT NULL
    AND (
      auth.uid() = meetups.circle_owner_id
      OR EXISTS (
        SELECT 1 FROM circle_memberships
        WHERE owner_id = meetups.circle_owner_id AND member_id = auth.uid()
      )
    )
  );

-- ============================================================================
-- meetup_invites
-- Per-user RSVP rows. Also triggers inbox item creation (done at API layer).
-- ============================================================================
CREATE TABLE IF NOT EXISTS meetup_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meetup_id  UUID NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','going','maybe','declined','cancelled')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meetup_invites_unique UNIQUE(meetup_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meetup_invites_meetup ON meetup_invites(meetup_id);
CREATE INDEX IF NOT EXISTS idx_meetup_invites_user   ON meetup_invites(user_id);

ALTER TABLE meetup_invites ENABLE ROW LEVEL SECURITY;

-- Own invite row
DROP POLICY IF EXISTS mi_own ON meetup_invites;
CREATE POLICY mi_own ON meetup_invites FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Creator of meetup can see all invites
DROP POLICY IF EXISTS mi_creator_select ON meetup_invites;
CREATE POLICY mi_creator_select ON meetup_invites FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetups
      WHERE id = meetup_invites.meetup_id AND creator_id = auth.uid()
    )
  );

-- Trip members can see invites for trip meetups
DROP POLICY IF EXISTS mi_trip_select ON meetup_invites;
CREATE POLICY mi_trip_select ON meetup_invites FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetups m
      JOIN trip_members tm ON tm.trip_id = m.trip_id
      WHERE m.id = meetup_invites.meetup_id
        AND m.visibility = 'trip'
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Circle members can see invites for circle meetups
DROP POLICY IF EXISTS mi_circle_select ON meetup_invites;
CREATE POLICY mi_circle_select ON meetup_invites FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetups m
      WHERE m.id = meetup_invites.meetup_id
        AND m.visibility = 'circle'
        AND (
          auth.uid() = m.circle_owner_id
          OR EXISTS (
            SELECT 1 FROM circle_memberships
            WHERE owner_id = m.circle_owner_id AND member_id = auth.uid()
          )
        )
    )
  );

-- Creator can insert/update/delete invites
DROP POLICY IF EXISTS mi_creator_write ON meetup_invites;
CREATE POLICY mi_creator_write ON meetup_invites FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM meetups
      WHERE id = meetup_invites.meetup_id AND creator_id = auth.uid()
    )
  );

-- ============================================================================
-- meetup_time_options
-- Time slots proposed by the organizer for voting.
-- ============================================================================
CREATE TABLE IF NOT EXISTS meetup_time_options (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meetup_id      UUID NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  proposed_date  DATE NOT NULL,
  time_block     TEXT CHECK (time_block IN ('morning','afternoon','evening','late')),
  label          TEXT CHECK (length(label) <= 200),  -- e.g. "Friday evening"
  confirmed      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mto_meetup ON meetup_time_options(meetup_id);

ALTER TABLE meetup_time_options ENABLE ROW LEVEL SECURITY;

-- Creator can manage options
DROP POLICY IF EXISTS mto_creator ON meetup_time_options;
CREATE POLICY mto_creator ON meetup_time_options FOR ALL
  USING (
    EXISTS (SELECT 1 FROM meetups WHERE id = meetup_time_options.meetup_id AND creator_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetups WHERE id = meetup_time_options.meetup_id AND creator_id = auth.uid())
  );

-- Invitees and scoped members can read
DROP POLICY IF EXISTS mto_invitee_select ON meetup_time_options;
CREATE POLICY mto_invitee_select ON meetup_time_options FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetup_invites
      WHERE meetup_id = meetup_time_options.meetup_id AND user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mto_trip_select ON meetup_time_options;
CREATE POLICY mto_trip_select ON meetup_time_options FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetups m
      JOIN trip_members tm ON tm.trip_id = m.trip_id
      WHERE m.id = meetup_time_options.meetup_id
        AND m.visibility = 'trip'
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

DROP POLICY IF EXISTS mto_circle_select ON meetup_time_options;
CREATE POLICY mto_circle_select ON meetup_time_options FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetups m
      WHERE m.id = meetup_time_options.meetup_id
        AND m.visibility = 'circle'
        AND (
          auth.uid() = m.circle_owner_id
          OR EXISTS (SELECT 1 FROM circle_memberships WHERE owner_id = m.circle_owner_id AND member_id = auth.uid())
        )
    )
  );

-- ============================================================================
-- meetup_time_votes
-- Upsertable: one vote per user per time option.
-- ============================================================================
CREATE TABLE IF NOT EXISTS meetup_time_votes (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id UUID NOT NULL REFERENCES meetup_time_options(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  vote      TEXT NOT NULL CHECK (vote IN ('yes','maybe','no')),
  voted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meetup_time_votes_unique UNIQUE(option_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mtv_option ON meetup_time_votes(option_id);
CREATE INDEX IF NOT EXISTS idx_mtv_user   ON meetup_time_votes(user_id);

ALTER TABLE meetup_time_votes ENABLE ROW LEVEL SECURITY;

-- Own votes
DROP POLICY IF EXISTS mtv_own ON meetup_time_votes;
CREATE POLICY mtv_own ON meetup_time_votes FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Creator can see all votes
DROP POLICY IF EXISTS mtv_creator_select ON meetup_time_votes;
CREATE POLICY mtv_creator_select ON meetup_time_votes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetup_time_options mto
      JOIN meetups m ON m.id = mto.meetup_id
      WHERE mto.id = meetup_time_votes.option_id AND m.creator_id = auth.uid()
    )
  );

-- Invitees can see aggregated votes (all votes on same option)
DROP POLICY IF EXISTS mtv_invitee_select ON meetup_time_votes;
CREATE POLICY mtv_invitee_select ON meetup_time_votes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM meetup_time_options mto
      JOIN meetup_invites mi ON mi.meetup_id = mto.meetup_id
      WHERE mto.id = meetup_time_votes.option_id AND mi.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Ensure meetup_invites can be inserted by creator via API layer (service role)
-- The service role bypasses RLS anyway, but we add proper RLS for direct access.
-- ============================================================================

-- No extra policies needed — service role handles all writes.

-- ============================================================================
-- trip_availability
-- Per (trip, user) date-keyed availability windows.
-- Separate from user_availability so trip-specific schedules don't pollute
-- the general weekly grid.
-- ============================================================================
CREATE TABLE IF NOT EXISTS trip_availability (
  trip_id    UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  open_days  JSONB NOT NULL DEFAULT '{}',
  -- e.g. {"2025-07-04": ["morning","evening"], "2025-07-05": ["afternoon"]}
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (trip_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_availability_trip ON trip_availability(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_availability_user ON trip_availability(user_id);

ALTER TABLE trip_availability ENABLE ROW LEVEL SECURITY;

-- Only accepted trip members can read/write their own trip availability row
DROP POLICY IF EXISTS ta_own ON trip_availability;
CREATE POLICY ta_own ON trip_availability FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_id = trip_availability.trip_id
        AND user_id = auth.uid()
        AND role IN ('owner', 'member')
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_id = trip_availability.trip_id
        AND user_id = auth.uid()
        AND role IN ('owner', 'member')
    )
  );

-- Accepted trip members can read fellow members' trip availability
DROP POLICY IF EXISTS ta_trip_members_select ON trip_availability;
CREATE POLICY ta_trip_members_select ON trip_availability FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM trip_members tm1
      JOIN trip_members tm2 ON tm1.trip_id = tm2.trip_id
      WHERE tm1.user_id = auth.uid()
        AND tm1.role IN ('owner', 'member')
        AND tm2.user_id = trip_availability.user_id
        AND tm2.trip_id = trip_availability.trip_id
        AND tm2.role IN ('owner', 'member')
    )
  );
