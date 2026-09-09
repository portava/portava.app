-- Rollback for 2470_media_asset_canonical_columns_flag_agnostic.sql
-- NOT applied anywhere as of 2026-09-07. 2470 itself is not applied anywhere
-- either; this file exists so the pair is complete before the owner decides.
--
-- WHAT 2470 DOES (identically to 2250 §1-§4, minus 2250's flag postcondition)
-- ==========================================================================
--   1. media_assets: captured_at, location_visibility (+ CHECK), provenance,
--      intelligence_eligibility.
--   2. media_assets_source_type_check.
--   3. media_assets_moderation_status_check (legacy 4-value) REPLACED by
--      media_assets_moderation_status_canonical_check (9-value superset).
--   4. media_attachments position / is_cover / visibility_override — asserted
--      present; 0191 created them, so 2470 adds nothing here and this rollback
--      does not touch them.
--
-- ⚠ ORDER MATTERS, AND SO DOES THE FLAG STATE.
-- ==========================================
-- Dropping these columns while `media_canonical_enabled` is TRUE puts the
-- database back into the state that produced the three-week silent write loss
-- — except that the code now REFUSES loudly (lib/media/mediaSchemaCapability)
-- instead of failing silently. So the rollback is safe for data but restores
-- an outage of the canonical writer. Set the flag FALSE first if the writer is
-- meant to stay quiet, or accept the error-level log on every upload.
--
-- ⚠ DROPPING THE COLUMNS DESTROYS DATA.
-- ====================================
-- Any row written after 2470 carries captured_at / provenance /
-- intelligence_eligibility that nothing else stores. The guard below refuses
-- if any such row exists, rather than discarding §6 provenance quietly.
--
-- ⚠ THE MODERATION CHECK NARROWS.
-- ==============================
-- Restoring the legacy 4-value CHECK fails if any row carries a canonical
-- value (processing/active/limited/removed/owner_deleted). The guard refuses
-- in that case too; rewrite those rows deliberately first.
--
-- Idempotent: re-running after everything is gone is a no-op.

BEGIN;

DO $$
DECLARE
  n_prov integer := 0;
  n_canon integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='media_assets' AND column_name='provenance') THEN
    EXECUTE 'SELECT count(*) FROM public.media_assets
              WHERE provenance IS NOT NULL OR intelligence_eligibility IS NOT NULL OR captured_at IS NOT NULL'
      INTO n_prov;
    IF n_prov > 0 THEN
      RAISE EXCEPTION 'REFUSED: % media_assets rows carry §6 provenance/capture data that this rollback would destroy. Export or null them deliberately first.', n_prov;
    END IF;
  END IF;

  SELECT count(*) INTO n_canon FROM public.media_assets
   WHERE moderation_status IN ('processing','active','limited','removed','owner_deleted');
  IF n_canon > 0 THEN
    RAISE EXCEPTION 'REFUSED: % media_assets rows carry a canonical moderation_status the legacy CHECK rejects. Rewrite them deliberately first.', n_canon;
  END IF;
END $$;

ALTER TABLE public.media_assets DROP CONSTRAINT IF EXISTS media_assets_source_type_check;
ALTER TABLE public.media_assets DROP CONSTRAINT IF EXISTS media_assets_moderation_status_canonical_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_moderation_status_check') THEN
    ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_moderation_status_check
      CHECK (moderation_status IN ('pending','approved','flagged','rejected'));
  END IF;
END $$;

ALTER TABLE public.media_assets DROP COLUMN IF EXISTS intelligence_eligibility;
ALTER TABLE public.media_assets DROP COLUMN IF EXISTS provenance;
ALTER TABLE public.media_assets DROP COLUMN IF EXISTS location_visibility;
ALTER TABLE public.media_assets DROP COLUMN IF EXISTS captured_at;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE n_cols integer;
BEGIN
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='media_assets'
     AND column_name IN ('captured_at','location_visibility','provenance','intelligence_eligibility');
  IF n_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % migration-2250/2470 columns remain on media_assets', n_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_moderation_status_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: legacy moderation_status CHECK not restored';
  END IF;
  -- The flag is not this file's to touch; report it so the log shows what the
  -- writer will do next (with the columns gone and the flag TRUE: refuse, loudly).
  RAISE NOTICE 'media_canonical_enabled = % (untouched)',
    (SELECT enabled FROM public.feature_flags WHERE flag='media_canonical_enabled');
END $$;

COMMIT;
