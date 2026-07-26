-- Migration: Real-place image accuracy — provenance columns on generated_visuals,
--            and image_source_type / image_accuracy_status on discovery_places & places.
--
-- This is Task 1 of the real-place image accuracy system. It extends the schema
-- so that every generated_visuals row can carry full provenance metadata and so
-- that place rows can record their current accuracy classification. Enforcement
-- logic, UI, and admin tooling are in subsequent tasks.
--
-- Design choices:
--   • All new columns are nullable with safe defaults (NULL or 'unverified').
--     Existing rows are unaffected.
--   • image_source_type TEXT (not an enum) so adding new classifications never
--     requires a blocking ALTER TYPE.
--   • reference_asset_ids is JSONB (array of text) indexed with GIN for fast
--     "which visuals used this reference?" look-ups.
--   • No ON DELETE behaviour changed; this migration is purely additive.
--
-- Fully idempotent: all statements use IF NOT EXISTS / DO NOTHING guards.

BEGIN;

-- ── generated_visuals: provenance columns ─────────────────────────────────────

-- Source classification (one of the nine canonical values)
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS image_source_type        TEXT;

-- Accuracy state; defaults to unverified for all new rows
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS accuracy_status          TEXT NOT NULL DEFAULT 'unverified';

-- Canonical place binding (non-null only for place-header visuals).
-- Added as plain UUID first; FK constraint is attached conditionally below
-- so the migration stays safe when the places table is not yet present.
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS canonical_place_id       UUID;

-- Provider's own place identifier (FSQ id, Google place_id, …)
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS provider_place_id        TEXT;

-- Direct URL to the source photo at the originating provider
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS source_url               TEXT;

-- Provider name: 'getty', 'unsplash', 'tripadvisor', 'portava', 'user', …
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS source_provider          TEXT;

-- SPDX license identifier or free-text description
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS source_license           TEXT;

-- Attribution string required by the license
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS source_attribution       TEXT;

-- Array of reference_asset ids used as input during AI generation
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS reference_asset_ids      JSONB;

-- Count of reference images provided to the AI generator
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS reference_image_count    INTEGER;

-- True when the final image was produced by an AI model
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS generated_with_ai        BOOLEAN NOT NULL DEFAULT false;

-- Generation method: 'dalle3', 'sdxl', 'flux', …
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS generation_method        TEXT;

-- Current verification pipeline state
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS verification_status      TEXT;

-- User who last changed verification_status
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS verified_by              UUID;

-- Timestamp of the last verification action
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS verified_at              TIMESTAMPTZ;

-- When true, the UI must render a disclaimer alongside this image
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS disclaimer_required      BOOLEAN NOT NULL DEFAULT false;

-- Disclaimer copy to show (e.g. "AI-generated representation")
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS disclaimer_text          TEXT;

-- When this row was last reviewed by the accuracy pipeline
ALTER TABLE generated_visuals
  ADD COLUMN IF NOT EXISTS last_accuracy_reviewed_at TIMESTAMPTZ;

-- GIN index for fast reference-asset look-ups
CREATE INDEX IF NOT EXISTS generated_visuals_reference_assets_gin
  ON generated_visuals USING GIN (reference_asset_ids)
  WHERE reference_asset_ids IS NOT NULL;

-- Index for accuracy-status filtering (admin queue, pipeline sweeps)
CREATE INDEX IF NOT EXISTS generated_visuals_accuracy_idx
  ON generated_visuals (accuracy_status);

-- ── discovery_places: accuracy classification columns ─────────────────────────

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS image_source_type   TEXT;

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS image_accuracy_status TEXT NOT NULL DEFAULT 'unverified';

-- ── places (canonical table): accuracy classification columns ─────────────────
--    Guard: the places table was introduced in a later migration wave; skip if absent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'places'
  ) THEN
    -- Attach the FK from generated_visuals.canonical_place_id → places.id now
    -- that we know places exists. Skip if the constraint is already present.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name   = 'generated_visuals'
        AND constraint_name = 'generated_visuals_canonical_place_id_fkey'
    ) THEN
      ALTER TABLE generated_visuals
        ADD CONSTRAINT generated_visuals_canonical_place_id_fkey
        FOREIGN KEY (canonical_place_id) REFERENCES places(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'places'
        AND column_name = 'image_source_type'
    ) THEN
      ALTER TABLE places ADD COLUMN image_source_type TEXT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'places'
        AND column_name = 'image_accuracy_status'
    ) THEN
      ALTER TABLE places ADD COLUMN image_accuracy_status TEXT NOT NULL DEFAULT 'unverified';
    END IF;
  END IF;
END $$;

COMMIT;
