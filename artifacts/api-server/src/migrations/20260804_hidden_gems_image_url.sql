-- 20260804_hidden_gems_image_url.sql
-- Add optional representative photo URL to hidden_gems.
-- image_url stores the public URL returned by the media-upload pipeline
-- after the client eagerly uploads via POST /api/media/upload.

ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS image_url TEXT;
