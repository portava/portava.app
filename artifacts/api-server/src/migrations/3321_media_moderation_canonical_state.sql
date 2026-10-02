-- 3321_media_moderation_canonical_state.sql
-- Media v2 — §36 MediaModerationStatus as the LIVE vocabulary of
-- media_assets.moderation_status, not merely an admissible one (census-media §20, MD274).
--
-- Additive + idempotent. Safe to re-run. Seeds NO flag, adds NO column, UPDATEs
-- NO row, changes NO CHECK.
--
-- NOT APPLIED ANYWHERE at the time of writing. The integrator applies it to
-- portava-ci after review. It CANNOT be applied to production until the owner
-- decision MEDIA_CANONICAL_FLAG is taken, and its precondition says so: the §36
-- values are legal only under 2250/2470's superset CHECK, which production lacks.
-- Rollback: db/rollback/2026-09-26-3321-media-moderation-canonical-state-rollback.sql
--
-- ── WHAT 2250 LEFT, AND WHY IT IS W ─────────────────────────────────────────
-- 2250 widened the CHECK to admit the §36 six alongside the legacy four and
-- "deliberately UPDATEs no row and leaves the DEFAULT as the legacy 'pending'".
-- So the canonical vocabulary was admissible and unused: every row a writer
-- created got the legacy default, and nothing ever wrote a §36 value except
-- the lifecycle's `owner_deleted` and the (never-run) backfill's `active`.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
--   1. DEFAULT 'processing'  — 2250's own documented equivalent of 'pending'
--      ("uploaded, not yet safety-cleared"). No behaviour changes: neither value
--      is in any distribution deny-list, because the product has no
--      pre-distribution hold (census-media MD269 — the open STAGE).
--   2. media_assets_canonical_moderation — BEFORE INSERT OR UPDATE OF
--      moderation_status: a legacy spelling is stored as its §36 meaning
--      (pending→processing, approved→active, flagged→limited; 2250's mapping,
--      verbatim). A writer that still speaks the legacy vocabulary keeps
--      working and the table only ever holds §36 values from here on.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--   • No bulk UPDATE of existing rows. Rewriting stored moderation state is a
--     data change, and this file is additive; an existing legacy row is
--     normalised the next time anything updates its moderation_status, and is
--     read in §36 terms meanwhile (lib/media/mediaAssetContract
--     .toCanonicalModerationStatus). An operator who wants every row canonical
--     at once runs the one-statement UPDATE in the rollback file's notes.
--   • No CHECK tightening. The superset stays, so no reader's legacy literal
--     becomes illegal under check:enum-literals.
--
-- ── READERS THAT HAD TO SPEAK §36 FIRST (same change set) ───────────────────
--   services/wall/WallCandidateLoaders QUICK_MEDIA_BLOCKED_MODERATION now blocks
--   `limited` (a `flagged` write is stored as `limited`; before this it would
--   have started reaching the Quick Media row), and services/telegraph/shareables
--   accepts `active` beside `approved` for a non-owner (before this every
--   promoted asset would have become unshareable). Both are one-line additive
--   edits named in census-media §20.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE def text; v text;
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets missing — apply 0191_media_assets.sql first.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.media_assets'::regclass
     AND conname = 'media_assets_moderation_status_canonical_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets_moderation_status_canonical_check is absent — this database still has the 0191 legacy-only CHECK, under which every §36 value this file writes is illegal. Apply 2250, or 2470 under the live flag (owner decision MEDIA_CANONICAL_FLAG), first.';
  END IF;
  FOREACH v IN ARRAY ARRAY['processing','active','limited','rejected','removed','owner_deleted'] LOOP
    IF position(quote_literal(v) IN def) = 0 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: the moderation CHECK does not admit the §36 value %', v;
    END IF;
  END LOOP;
END $$;

-- ── 1. The default is the §36 spelling ──────────────────────────────────────
ALTER TABLE public.media_assets ALTER COLUMN moderation_status SET DEFAULT 'processing';

-- ── 2. Legacy spellings are stored as their §36 meaning ─────────────────────
CREATE OR REPLACE FUNCTION public.media_assets_canonical_moderation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.moderation_status := CASE NEW.moderation_status
    WHEN 'pending'  THEN 'processing'
    WHEN 'approved' THEN 'active'
    WHEN 'flagged'  THEN 'limited'
    ELSE NEW.moderation_status
  END;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.media_assets_canonical_moderation() FROM PUBLIC;

DROP TRIGGER IF EXISTS media_assets_canonical_moderation ON public.media_assets;
CREATE TRIGGER media_assets_canonical_moderation
  BEFORE INSERT OR UPDATE OF moderation_status ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.media_assets_canonical_moderation();

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE d text;
BEGIN
  SELECT column_default INTO d FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'moderation_status';
  IF d IS NULL OR d NOT LIKE '''processing''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.moderation_status default is %, expected the §36 ''processing''', d;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.media_assets'::regclass
                   AND tgname = 'media_assets_canonical_moderation'
                   AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets_canonical_moderation trigger missing or disabled';
  END IF;
END $$;

COMMIT;
