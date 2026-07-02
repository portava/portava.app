-- 0080_events_extension.sql
-- Extends the Events system with missing tables and columns.
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS column).

-- ── Extend events table ───────────────────────────────────────────────────────

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS show_exact_location BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rsvp_closed          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS safety_notes         TEXT,
  ADD COLUMN IF NOT EXISTS tags                 TEXT[] NOT NULL DEFAULT '{}';

-- ── event_saves ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_saves (
  event_id  UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_saves_user_idx ON event_saves(user_id);

ALTER TABLE event_saves ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_saves_own" ON event_saves;
  CREATE POLICY "event_saves_own" ON event_saves
    FOR ALL USING (user_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_invites ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  inviter_id  UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  invitee_id  UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, invitee_id)
);

CREATE INDEX IF NOT EXISTS event_invites_event_idx   ON event_invites(event_id);
CREATE INDEX IF NOT EXISTS event_invites_invitee_idx ON event_invites(invitee_id);

ALTER TABLE event_invites ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_invites_invitee_read" ON event_invites;
  CREATE POLICY "event_invites_invitee_read" ON event_invites
    FOR SELECT USING (invitee_id = auth.uid() OR inviter_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_invites_inviter_insert" ON event_invites;
  CREATE POLICY "event_invites_inviter_insert" ON event_invites
    FOR INSERT WITH CHECK (inviter_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_invites_invitee_update" ON event_invites;
  CREATE POLICY "event_invites_invitee_update" ON event_invites
    FOR UPDATE USING (invitee_id = auth.uid() OR inviter_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_cohosts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_cohosts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  permissions JSONB NOT NULL DEFAULT '{"manage_rsvps":true,"manage_chat":true,"post_updates":true}',
  added_by    UUID NOT NULL REFERENCES auth.users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_cohosts_event_idx ON event_cohosts(event_id);
CREATE INDEX IF NOT EXISTS event_cohosts_user_idx  ON event_cohosts(user_id);

ALTER TABLE event_cohosts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_cohosts_read" ON event_cohosts;
  CREATE POLICY "event_cohosts_read" ON event_cohosts
    FOR SELECT USING (true);
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_posts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  body       TEXT NOT NULL,
  media_urls TEXT[] NOT NULL DEFAULT '{}',
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_posts_event_idx ON event_posts(event_id, created_at DESC);

ALTER TABLE event_posts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_posts_read" ON event_posts;
  CREATE POLICY "event_posts_read" ON event_posts
    FOR SELECT USING (true);
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_posts_author_write" ON event_posts;
  CREATE POLICY "event_posts_author_write" ON event_posts
    FOR ALL USING (author_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_media ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_media (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  uploader_id  UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  media_url    TEXT NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'image'
                 CHECK (media_type IN ('image','video')),
  caption      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_media_event_idx ON event_media(event_id, created_at DESC);

ALTER TABLE event_media ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_media_read" ON event_media;
  CREATE POLICY "event_media_read" ON event_media
    FOR SELECT USING (true);
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_media_uploader_write" ON event_media;
  CREATE POLICY "event_media_uploader_write" ON event_media
    FOR ALL USING (uploader_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_reports ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  reporter_id    UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  report_type    TEXT NOT NULL DEFAULT 'event'
                   CHECK (report_type IN ('event','user')),
  target_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','reviewed','dismissed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, reporter_id, report_type)
);

CREATE INDEX IF NOT EXISTS event_reports_event_idx    ON event_reports(event_id);
CREATE INDEX IF NOT EXISTS event_reports_reporter_idx ON event_reports(reporter_id);

ALTER TABLE event_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_reports_reporter_read" ON event_reports;
  CREATE POLICY "event_reports_reporter_read" ON event_reports
    FOR SELECT USING (reporter_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_reports_reporter_insert" ON event_reports;
  CREATE POLICY "event_reports_reporter_insert" ON event_reports
    FOR INSERT WITH CHECK (reporter_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_activity_log ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_activity_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  actor_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_activity_event_idx ON event_activity_log(event_id, created_at DESC);

ALTER TABLE event_activity_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_activity_host_read" ON event_activity_log;
  CREATE POLICY "event_activity_host_read" ON event_activity_log
    FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM events e
        WHERE e.id = event_id
          AND (e.host_id = auth.uid()
               OR EXISTS (SELECT 1 FROM event_roles er
                          WHERE er.event_id = e.id
                            AND er.user_id = auth.uid()
                            AND er.role IN ('co_host','moderator')))
      )
    );
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_share_links ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_share_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  max_uses   INTEGER,
  use_count  INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_share_links_event_idx ON event_share_links(event_id);
CREATE INDEX IF NOT EXISTS event_share_links_token_idx ON event_share_links(token);

ALTER TABLE event_share_links ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_share_links_creator_manage" ON event_share_links;
  CREATE POLICY "event_share_links_creator_manage" ON event_share_links
    FOR ALL USING (creator_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_share_links_public_read" ON event_share_links;
  CREATE POLICY "event_share_links_public_read" ON event_share_links
    FOR SELECT USING (true);
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_reminders ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_reminders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id)      ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  remind_at  TIMESTAMPTZ NOT NULL,
  note       TEXT,
  sent       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, user_id, remind_at)
);

CREATE INDEX IF NOT EXISTS event_reminders_user_idx     ON event_reminders(user_id, remind_at);
CREATE INDEX IF NOT EXISTS event_reminders_unsent_idx   ON event_reminders(remind_at) WHERE NOT sent;

ALTER TABLE event_reminders ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_reminders_own" ON event_reminders;
  CREATE POLICY "event_reminders_own" ON event_reminders
    FOR ALL USING (user_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── event_drafts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data          JSONB NOT NULL DEFAULT '{}',
  last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_drafts_host_idx ON event_drafts(host_id, last_saved_at DESC);

ALTER TABLE event_drafts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS "event_drafts_own" ON event_drafts;
  CREATE POLICY "event_drafts_own" ON event_drafts
    FOR ALL USING (host_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

-- ── Feature flag seeds ────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('events_invites_enabled',   true,  'Event invite system'),
  ('events_cohosts_enabled',   true,  'Event co-host system'),
  ('events_reports_enabled',   true,  'Event reporting'),
  ('events_reminders_enabled', true,  'Event reminders'),
  ('events_share_links_enabled', true, 'Event shareable links')
ON CONFLICT (flag) DO NOTHING;
