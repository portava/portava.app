-- Migration: 2089_media_assets_ready_requires_dimensions.sql
--
-- Adds a DB-level CHECK constraint preventing NEW media_assets writes from
-- reaching processing_status='ready' without width and height being set.
--
-- Context: migration 2088 added an equivalent constraint to post_media.
-- The recordMediaAsset() function (lib/mediaAssets.ts) is called from
-- /posts/media/upload for every upload, flag-gated via media_canonical_enabled
-- (currently OFF). For video uploads, width and height are null at upload time
-- (no server-side video measurement), and the original code defaulted
-- processing_status to 'ready' — the same class of defect 2088 fixed for
-- post_media. This constraint closes the same gap for media_assets.
--
-- NOT VALID: enforces the constraint for all INSERT and UPDATE operations
-- immediately, but skips scanning existing rows (which may have legacy
-- ready+NULL rows from before this migration). Safe to apply without first
-- resolving historical NULL rows.
--
-- Remediation path: once every ready+NULL media_assets row has had its
-- dimensions populated by a backfill, run:
--
--   ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_ready_has_dimensions;
--
-- That promotes the constraint to fully validated.
ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_ready_has_dimensions
  CHECK (
    processing_status <> 'ready'
    OR (width IS NOT NULL AND height IS NOT NULL)
  ) NOT VALID;
