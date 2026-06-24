-- Migration: 0026_highlights.sql
-- Creates highlights and associated engagement tables.

CREATE TYPE IF NOT EXISTS highlight_visibility AS ENUM (
  'public', 'travelers_nearby', 'circle_only', 'trip_only', 'private'
);

CREATE TABLE IF NOT EXISTS highlights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id       uuid REFERENCES trips(id) ON DELETE SET NULL,
  media_url     text,
  caption       text,
  visibility    highlight_visibility NOT NULL DEFAULT 'public',
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS highlights_user_idx    ON highlights(user_id);
CREATE INDEX IF NOT EXISTS highlights_expires_idx ON highlights(expires_at) WHERE deleted_at IS NULL;

ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "highlights_select" ON highlights
  FOR SELECT USING (deleted_at IS NULL AND expires_at > now());

CREATE POLICY "highlights_insert" ON highlights
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "highlights_update_own" ON highlights
  FOR UPDATE USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS highlight_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id uuid NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  viewer_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT highlight_views_unique UNIQUE (highlight_id, viewer_id)
);

ALTER TABLE highlight_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "highlight_owner_views" ON highlight_views
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM highlights h WHERE h.id = highlight_id AND h.user_id = auth.uid())
  );

CREATE POLICY "viewer_insert_view" ON highlight_views
  FOR INSERT WITH CHECK (auth.uid() = viewer_id);


CREATE TABLE IF NOT EXISTS highlight_likes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id uuid NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT highlight_likes_unique UNIQUE (highlight_id, user_id)
);

ALTER TABLE highlight_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_highlight_likes"   ON highlight_likes FOR SELECT USING (true);
CREATE POLICY "users_insert_highlight_like"  ON highlight_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_delete_own_like"        ON highlight_likes FOR DELETE USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS highlight_replies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id uuid NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body         text NOT NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE highlight_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_highlight_replies"  ON highlight_replies FOR SELECT USING (deleted_at IS NULL);
CREATE POLICY "users_insert_highlight_reply"  ON highlight_replies FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_delete_own_reply"        ON highlight_replies FOR DELETE USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS highlight_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id uuid NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  reporter_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT highlight_reports_unique UNIQUE (highlight_id, reporter_id)
);

ALTER TABLE highlight_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_insert_highlight_report" ON highlight_reports
  FOR INSERT WITH CHECK (auth.uid() = reporter_id);
