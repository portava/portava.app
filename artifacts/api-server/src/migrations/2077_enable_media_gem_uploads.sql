-- Enable the three feature flags required for the Add a Gem upload flow.
--
-- MEDIA_UPLOAD_ENABLED       — master upload gate (was false; unblocks the
--                              "Media uploads disabled" screen in AddGemForm)
-- MEDIA_UPLOAD_PHOTO_ENABLED — photo uploads specifically (was false)
-- MEDIA_GEMS_SUBMIT_ENABLED  — gem submission gate (was false)
--
-- Object storage (post-media bucket) was confirmed present and private before
-- this migration was applied (see 20260806_media_private_buckets.sql).

UPDATE feature_flags SET enabled = true
WHERE flag IN (
  'MEDIA_UPLOAD_ENABLED',
  'MEDIA_UPLOAD_PHOTO_ENABLED',
  'MEDIA_GEMS_SUBMIT_ENABLED'
);
