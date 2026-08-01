-- Migration 2055: expand stamp_artwork_versions.generation_source constraint
--
-- The original migration (0121_universal_stamp_catalog.sql) defined:
--   generation_source CHECK (generation_source IN ('ai_generated', 'admin_upload'))
--
-- The placeholder-provider detection feature (task 2957) stores candidates
-- produced by the dev PlaceholderProvider with generation_source = 'placeholder'
-- so the admin review screen can filter them and the provider_degraded health
-- flag has persistent evidence to query. The existing constraint would reject
-- those inserts with a check-constraint violation.
--
-- This migration:
--   1. Drops the old unnamed check constraint.
--   2. Adds a new named constraint including ALL values written by server code:
--        ai_generated   — real AI artwork (DalleProvider / gpt-image-1)
--        admin_upload   — manually uploaded via the admin artwork endpoint
--        placeholder    — dev placeholder SVG (PlaceholderProvider fallback)
--        recomposed     — admin recompose flow (stampCatalog.ts recompose endpoint)
--
-- Postgres names unnamed inline CHECK constraints as <table>_<column>_check.
-- If the constraint was already dropped or renamed by a prior migration the
-- DROP is harmless (IF EXISTS).

ALTER TABLE stamp_artwork_versions
  DROP CONSTRAINT IF EXISTS stamp_artwork_versions_generation_source_check;

ALTER TABLE stamp_artwork_versions
  ADD CONSTRAINT stamp_artwork_versions_generation_source_check
  CHECK (generation_source IN ('ai_generated', 'admin_upload', 'placeholder', 'recomposed'));
