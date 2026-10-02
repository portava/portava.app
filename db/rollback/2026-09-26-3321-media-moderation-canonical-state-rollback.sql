-- Rollback for 3321_media_moderation_canonical_state.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb) — 3321's precondition
-- refuses that database until the owner decision MEDIA_CANONICAL_FLAG.
--
-- WHAT 3321 DID
-- =============
--   * ALTER COLUMN media_assets.moderation_status SET DEFAULT 'processing'
--   * CREATE FUNCTION public.media_assets_canonical_moderation() + the
--     BEFORE INSERT OR UPDATE OF moderation_status trigger of the same name,
--     storing a legacy spelling as its §36 meaning.
--   No row, no CHECK, no flag.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the trigger and function and restores 2250's DEFAULT 'pending'. It
-- does NOT rewrite rows back to legacy spellings: every §36 value a row holds
-- is legal under the superset CHECK, and 'processing' / 'active' / 'limited'
-- mean exactly what 'pending' / 'approved' / 'flagged' meant (2250's mapping).
--
-- NOTE — the operator's one-statement normalisation 3321 deliberately does not
-- run (it is a data change, and 3321 is additive):
--   UPDATE public.media_assets
--      SET moderation_status = CASE moderation_status
--            WHEN 'pending' THEN 'processing' WHEN 'approved' THEN 'active'
--            WHEN 'flagged' THEN 'limited' END
--    WHERE moderation_status IN ('pending','approved','flagged');

BEGIN;

DROP TRIGGER IF EXISTS media_assets_canonical_moderation ON public.media_assets;
DROP FUNCTION IF EXISTS public.media_assets_canonical_moderation();
ALTER TABLE public.media_assets ALTER COLUMN moderation_status SET DEFAULT 'pending';

DO $$
DECLARE d text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.media_assets'::regclass AND tgname = 'media_assets_canonical_moderation') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets_canonical_moderation still present after rollback';
  END IF;
  IF to_regprocedure('public.media_assets_canonical_moderation()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.media_assets_canonical_moderation() still present after rollback';
  END IF;
  SELECT column_default INTO d FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'moderation_status';
  IF d IS NULL OR d NOT LIKE '''pending''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation_status default is % after rollback, expected ''pending''', d;
  END IF;
END $$;

COMMIT;
