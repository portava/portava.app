-- Rollback for 3320_media_canonical_contract_constraints.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3320 DID
-- =============
--   * ADD CONSTRAINT media_attachments_entity_type_check          (§6.1 nine)
--   * ADD CONSTRAINT media_attachments_visibility_override_check  (NULL | inherit | §33 six)
--   * ADD CONSTRAINT media_assets_visibility_check                (inherit | §33 six)
--   * CREATE FUNCTION public.media_assets_bump_version() + BEFORE UPDATE trigger
--     media_assets_version_bump (NEW.version := OLD.version + 1).
--   No column, no row, no flag, no grant beyond REVOKE ALL ON the function FROM PUBLIC.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops exactly those five objects. It changes no row: every value 3320 made
-- the database enforce was already required of existing rows by 3320's own
-- preconditions, and version values stay as the trigger left them (monotonic,
-- still valid for the 0191 column). After this runs, the version is a constant
-- again for every writer except lib/mediaAssets.casUpdateMediaAsset, which
-- writes expected+1 itself — so the compare-and-set still detects its own races,
-- but a lifecycle/upsert write no longer moves the version under it.

BEGIN;

DROP TRIGGER IF EXISTS media_assets_version_bump ON public.media_assets;
DROP FUNCTION IF EXISTS public.media_assets_bump_version();

ALTER TABLE public.media_assets      DROP CONSTRAINT IF EXISTS media_assets_visibility_check;
ALTER TABLE public.media_attachments DROP CONSTRAINT IF EXISTS media_attachments_visibility_override_check;
ALTER TABLE public.media_attachments DROP CONSTRAINT IF EXISTS media_attachments_entity_type_check;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.media_assets'::regclass AND tgname = 'media_assets_version_bump') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets_version_bump still present after rollback';
  END IF;
  IF to_regprocedure('public.media_assets_bump_version()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.media_assets_bump_version() still present after rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname IN ('media_assets_visibility_check',
                               'media_attachments_visibility_override_check',
                               'media_attachments_entity_type_check')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a 3320 constraint is still present after rollback';
  END IF;
END $$;

COMMIT;
