-- 20260806_media_private_buckets.sql
--
-- Two related changes:
--
-- 1. Activates private-bucket mode for post-media and profile-media.
--    The application code in src/routes/mediaFile.ts no longer checks this flag
--    (the signed-URL path is now unconditional), but the row serves as the
--    permanent record of when the cutover was completed and as the gate for the
--    companion bucket-flip script (src/scripts/set-media-buckets-private.ts),
--    which refuses to make buckets private until this flag is ON.
--
--    After this migration is applied, run the bucket-flip script:
--
--      node --import tsx/esm src/scripts/set-media-buckets-private.ts
--
--    That script sets public=false on the post-media and profile-media buckets
--    via the Supabase Management API so that raw /object/public/ URLs 403.
--    The script is idempotent and safe to re-run.
--
-- 2. Adds show_header_publicly columns to events and trips.
--    When false, the media-serving route returns a generic branded cover image
--    instead of signing the real asset, so private event/trip headers are not
--    exposed to non-members who guess the media path.
--    Defaults to TRUE for existing rows (no change in current behaviour).

INSERT INTO feature_flags (flag, enabled, description)
VALUES (
  'media_private_buckets_enabled',
  TRUE,
  'post-media and profile-media buckets are PRIVATE; all media is served through the signed-URL relay (GET /api/media/file). Permanently ON as of 2026-08-06.'
)
ON CONFLICT (flag) DO UPDATE
  SET enabled     = TRUE,
      description = EXCLUDED.description;

-- show_header_publicly: controls whether the media relay will sign the real
-- header image for this entity or fall back to a generic cover placeholder.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS show_header_publicly BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS show_header_publicly BOOLEAN NOT NULL DEFAULT TRUE;
