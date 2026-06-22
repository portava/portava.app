-- Migration: 0026_highlights.sql
-- Creates highlights system tables: highlights, highlight_views, highlight_likes,
-- highlight_replies, highlight_reports. All with RLS policies.

-- ── highlights ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlights (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_url              TEXT NOT NULL,
  media_type             TEXT NOT NULL,
  video_duration_seconds FLOAT,
  caption                TEXT,
  location_name          TEXT,
  location_city          TEXT,
  location_country       TEXT,
  visibility             TEXT NOT NULL DEFAULT 'public'
                           CHECK (visibility IN ('public','travelers_nearby','circle_only','trip_only','private')),
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  archived_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS highlights_owner_active_idx
  ON highlights (owner_id, expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS highlights_expires_idx
  ON highlights (expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS highlights_location_city_idx
  ON highlights (location_city)
  WHERE deleted_at IS NULL AND location_city IS NOT NULL;

ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

-- Owner can insert own highlights
CREATE POLICY "highlights_insert_own" ON highlights
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- Owner can soft-delete own highlights
CREATE POLICY "highlights_update_own" ON highlights
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid());

-- Visibility-enforced SELECT policy.
-- Clients may query Supabase directly, so we enforce all tiers in SQL.
-- 'public'/'travelers_nearby' — any authenticated user (not blocked by owner)
-- 'circle_only'              — viewer must be in the owner's circle_memberships
-- 'trip_only'                — viewer and owner must share at least one trip
-- 'private'                  — only the owner
CREATE POLICY "highlights_select_active" ON highlights
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND expires_at > now()
    AND NOT is_blocked(auth.uid(), owner_id)
    AND (
      owner_id = auth.uid()
      OR (
        visibility IN ('public', 'travelers_nearby')
      )
      OR (
        visibility = 'circle_only'
        AND EXISTS (
          SELECT 1 FROM circle_memberships cm
          WHERE cm.owner_id = highlights.owner_id
            AND cm.member_id = auth.uid()
        )
      )
      OR (
        visibility = 'trip_only'
        AND EXISTS (
          SELECT 1 FROM trip_members tm1
          JOIN trip_members tm2 ON tm1.trip_id = tm2.trip_id
          WHERE tm1.user_id = highlights.owner_id
            AND tm2.user_id = auth.uid()
        )
      )
    )
  );

-- ── highlight_views ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlight_views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  viewer_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (highlight_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS hviews_highlight_idx ON highlight_views (highlight_id);
CREATE INDEX IF NOT EXISTS hviews_viewer_idx    ON highlight_views (viewer_id);

ALTER TABLE highlight_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hviews_insert_own" ON highlight_views
  FOR INSERT TO authenticated
  WITH CHECK (viewer_id = auth.uid());

CREATE POLICY "hviews_upsert_own" ON highlight_views
  FOR UPDATE TO authenticated
  USING (viewer_id = auth.uid());

-- Viewer can see their own view rows; highlight owner can see all views for their highlights
CREATE POLICY "hviews_select" ON highlight_views
  FOR SELECT TO authenticated
  USING (
    viewer_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM highlights h
      WHERE h.id = highlight_views.highlight_id AND h.owner_id = auth.uid()
    )
  );

-- ── highlight_likes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlight_likes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (highlight_id, user_id)
);

CREATE INDEX IF NOT EXISTS hlikes_highlight_idx ON highlight_likes (highlight_id);
CREATE INDEX IF NOT EXISTS hlikes_user_idx      ON highlight_likes (user_id);

ALTER TABLE highlight_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hlikes_insert_own" ON highlight_likes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "hlikes_delete_own" ON highlight_likes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "hlikes_select_all" ON highlight_likes
  FOR SELECT TO authenticated
  USING (true);

-- ── highlight_replies ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlight_replies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  replier_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  thread_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hreplies_highlight_idx ON highlight_replies (highlight_id);
CREATE INDEX IF NOT EXISTS hreplies_replier_idx   ON highlight_replies (replier_id);

ALTER TABLE highlight_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hreplies_insert_own" ON highlight_replies
  FOR INSERT TO authenticated
  WITH CHECK (replier_id = auth.uid());

-- Owner of highlight can see all replies to their highlights; replier can see own
CREATE POLICY "hreplies_select" ON highlight_replies
  FOR SELECT TO authenticated
  USING (
    replier_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM highlights h
      WHERE h.id = highlight_replies.highlight_id AND h.owner_id = auth.uid()
    )
  );

-- ── highlight_reports ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlight_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  reporter_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL DEFAULT 'inappropriate',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (highlight_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS hreports_highlight_idx ON highlight_reports (highlight_id);

ALTER TABLE highlight_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hreports_insert_own" ON highlight_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

CREATE POLICY "hreports_select_own" ON highlight_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid());
