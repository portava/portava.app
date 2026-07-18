-- 0149: Add photo_url to passport_memories.
-- Allows users to attach a single image to a memory via the image picker
-- in the Memory creation form. The URL points to a Supabase Storage object
-- uploaded via POST /api/media/upload (service-role key).

ALTER TABLE passport_memories ADD COLUMN IF NOT EXISTS photo_url text;
