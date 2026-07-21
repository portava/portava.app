-- Migration: post_event_links
-- Enables explicit post-to-Portava-Event linking for the Discovery event-post pipeline.
-- posts.event_id was intentionally removed (PGRST204 issue); this join table is the
-- correct approach and avoids touching the posts schema.

CREATE TABLE IF NOT EXISTS post_event_links (
  post_id   UUID NOT NULL REFERENCES posts(id)   ON DELETE CASCADE,
  event_id  UUID NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_post_event_links_post_id   ON post_event_links (post_id);
CREATE INDEX IF NOT EXISTS idx_post_event_links_event_id  ON post_event_links (event_id);
