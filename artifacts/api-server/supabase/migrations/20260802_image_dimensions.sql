-- Store actual pixel dimensions for cover/avatar images so OG previews can emit
-- exact og:image:width / og:image:height tags (required by iMessage for the
-- large preview card — without them it falls back to the plain URL).
--
-- All columns are nullable integers. Existing rows default to NULL, and the OG
-- route already guards against NULL by omitting the dimension tags gracefully.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_image_width  integer,
  ADD COLUMN IF NOT EXISTS cover_image_height integer;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS cover_image_width  integer,
  ADD COLUMN IF NOT EXISTS cover_image_height integer;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS avatar_image_width  integer,
  ADD COLUMN IF NOT EXISTS avatar_image_height integer,
  ADD COLUMN IF NOT EXISTS cover_image_width   integer,
  ADD COLUMN IF NOT EXISTS cover_image_height  integer;
