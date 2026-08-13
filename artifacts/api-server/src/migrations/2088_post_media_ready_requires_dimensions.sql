-- Migration: 2088_post_media_ready_requires_dimensions.sql
--
-- Adds a DB-level CHECK constraint that prevents NEW post_media writes from
-- reaching processing_status='ready' without width and height being set.
--
-- Context: the legacy upload path (pre-0103) never populated width/height on
-- some rows. Migration 2083 backfills storage-backed rows but deliberately
-- leaves video rows at ready+NULL until their dimensions can be measured
-- (videos have no server-side measurement tier). The thumbnail generation
-- pipeline (migration 0208) silently skips NULL-dimension rows — producing no
-- thumbnails — with no error. The application-level guard added alongside this
-- migration rejects new completion attempts before they reach the DB, but the
-- constraint is the authoritative enforcement for any future code path that
-- might forget to validate.
--
-- NOT VALID: PostgreSQL enforces the constraint for all INSERT and UPDATE
-- operations immediately, but skips scanning existing rows (which may still
-- have ready+NULL rows from before 0103 / 2083). This makes the migration safe
-- to apply in production without first resolving every historical NULL row.
--
-- Remediation path: once a follow-up backfill has populated width/height for
-- every remaining ready+NULL row, run:
--
--   ALTER TABLE post_media VALIDATE CONSTRAINT post_media_ready_has_dimensions;
--
-- That promotes the constraint to fully validated and enables the planner to
-- use it for optimisations.
ALTER TABLE post_media
  ADD CONSTRAINT post_media_ready_has_dimensions
  CHECK (
    processing_status <> 'ready'
    OR (width IS NOT NULL AND height IS NOT NULL)
  ) NOT VALID;
