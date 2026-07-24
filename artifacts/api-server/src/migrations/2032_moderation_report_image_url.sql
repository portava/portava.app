-- Migration 2032: add image_url to moderation_reports
--
-- Safety-concern reports can now include an optional photo as evidence.
-- The field accepts a single CDN URL uploaded via the client media pipeline.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.

ALTER TABLE moderation_reports
  ADD COLUMN IF NOT EXISTS image_url text DEFAULT NULL;
