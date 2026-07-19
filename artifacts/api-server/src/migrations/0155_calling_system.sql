-- Migration 0155: Portava calling system (calls spec §8, addendum B)
--
-- ONE canonical call-session model consumed by every context
-- (telegraph_dm / rent_a_buddy / trip_crew / event). Metadata only:
-- no audio, no video, no transcripts are ever stored (spec §21).
--
-- room_name is the opaque LiveKit room id (pcall_<random>) — never derived
-- from thread/event ids (spec §9). Unique so webhook reconciliation can map
-- room → session unambiguously.

CREATE TABLE IF NOT EXISTS call_sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_type     text        NOT NULL CHECK (call_type IN ('voice','video','group_voice')),
  context_type  text        NOT NULL CHECK (context_type IN ('telegraph_dm','rent_a_buddy','trip_crew','event')),
  context_id    text        NOT NULL,             -- thread/booking/trip/event anchor id
  thread_id     uuid        NULL,                 -- Telegraph thread when applicable
  room_name     text        NOT NULL UNIQUE,      -- opaque LiveKit room (pcall_*)
  started_by    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'ringing'
                            CHECK (status IN ('ringing','active','ended','missed','declined','canceled','failed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  connected_at  timestamptz NULL,
  ended_at      timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Open-call sweeps (ring expiry / 4h cap / ghost healing) scan only open rows.
CREATE INDEX IF NOT EXISTS idx_call_sessions_open
  ON call_sessions (status, started_at)
  WHERE status IN ('ringing','active');

-- Contextual history ("calls in this thread") and per-context lookups.
CREATE INDEX IF NOT EXISTS idx_call_sessions_thread   ON call_sessions (thread_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_context  ON call_sessions (context_type, context_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_starter  ON call_sessions (started_by, started_at DESC);

CREATE TABLE IF NOT EXISTS call_participants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     uuid        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('caller','callee','host','cohost','speaker','listener','participant')),
  status      text        NOT NULL DEFAULT 'invited'
                          CHECK (status IN ('invited','ringing','joined','declined','missed','left','removed')),
  invited_at  timestamptz NULL DEFAULT now(),
  joined_at   timestamptz NULL,
  left_at     timestamptz NULL,
  UNIQUE (call_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants (user_id, call_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants (call_id);

-- Calling preferences (spec §7). Dedicated table: the existing preference
-- surfaces are feature-scoped, and calling prefs must be enforceable
-- server-side with one cheap PK lookup. Absent row = defaults.
CREATE TABLE IF NOT EXISTS call_preferences (
  user_id                     uuid    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  who_can_call                text    NOT NULL DEFAULT 'people_i_message'
                                      CHECK (who_can_call IN ('people_i_message','rab_contacts','nobody')),
  allow_rent_a_buddy_calls    boolean NOT NULL DEFAULT true,
  allow_video_calls           boolean NOT NULL DEFAULT true,
  incoming_call_notifications boolean NOT NULL DEFAULT true,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- All writes go through the API server (service role). Authenticated users
-- may read only sessions they participate in, and only their own preferences.

ALTER TABLE call_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_preferences  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_sessions_select ON call_sessions;
CREATE POLICY call_sessions_select ON call_sessions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM call_participants cp
    WHERE cp.call_id = call_sessions.id AND cp.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS call_participants_select ON call_participants;
CREATE POLICY call_participants_select ON call_participants FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM call_participants me
    WHERE me.call_id = call_participants.call_id AND me.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS call_preferences_select ON call_preferences;
CREATE POLICY call_preferences_select ON call_preferences FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS call_preferences_upsert ON call_preferences;
CREATE POLICY call_preferences_upsert ON call_preferences FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS call_preferences_update ON call_preferences;
CREATE POLICY call_preferences_update ON call_preferences FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
