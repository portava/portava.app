-- 0150_event_cover_media_type.sql
-- Adds cover_media_type column to events so list/detail queries can return
-- whether the cover asset is an image or video without a join on event_media.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_media_type TEXT
    CHECK (cover_media_type IN ('image', 'video'));
