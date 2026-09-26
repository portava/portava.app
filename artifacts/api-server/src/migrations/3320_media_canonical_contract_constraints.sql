-- 3320_media_canonical_contract_constraints.sql
-- Media v2 — the §6 / §6.1 / §33 canonical contract ENFORCED by the database,
-- and the §6 `version` made a real aggregate version (census-media §20).
--
-- Additive + idempotent. Safe to re-run. Seeds NO flag, changes NO flag, adds
-- NO column, and UPDATEs no row.
--
-- NOT APPLIED ANYWHERE at the time of writing. The integrator applies it to
-- portava-ci after review; production is the owner's call.
-- Rollback: db/rollback/2026-09-26-3320-media-canonical-contract-constraints-rollback.sql
--
-- ── WHAT IT ADDS, AND THE ROW EACH ONE IS FOR ───────────────────────────────
--   1. media_attachments_entity_type_check                     (MD41)
--        entity_type IN the §6.1 nine: post | postcard | memory | trip | place |
--        event | hidden_gem | shared_moment | observation.
--        0191 created the column as bare TEXT — nine required values, zero
--        enforced. The app layer (lib/mediaAssets.ATTACHMENT_ENTITY_TYPES)
--        already refuses anything else; now the table does too, for every
--        writer, including the ones that do not go through that module.
--   2. media_attachments_visibility_override_check             (MD43 / MD255)
--        visibility_override IS NULL OR IN inherit + the §33 six
--        (public | followers | following | trip_crew | shared_moment | private).
--        The reader (lib/mediaVisibility.mayViewUnderOverride) DENIES any other
--        value; a CHECK means such a value can no longer be stored to be denied.
--   3. media_assets_visibility_check                           (MD36 / MD255)
--        visibility IN inherit + the same six. 0191's column is bare TEXT
--        DEFAULT 'inherit' with no CHECK at all.
--   4. media_assets_version_bump — BEFORE UPDATE, FOR EACH ROW (MD38)
--        NEW.version := OLD.version + 1 on EVERY update, whoever issues it.
--        `version INTEGER NOT NULL DEFAULT 1` has existed since 0191 and nothing
--        incremented it, so the §6 "versioned aggregate" was a constant. With
--        the trigger the version moves with the row even for writers that never
--        read it (the processing lifecycle, the upload upsert, transcode
--        completion), and lib/mediaAssets.casUpdateMediaAsset — the
--        compare-and-set every read-modify-write of provenance goes through —
--        has something real to compare against. A writer cannot forge or rewind
--        it: whatever NEW.version it sends is overwritten.
--
-- ── WHY THIS IS INDEPENDENT OF THE OPEN OWNER DECISION ─────────────────────
-- MEDIA_CANONICAL_FLAG (migration-disposition-ledger) is about 2250/2470 — the
-- captured_at / location_visibility / provenance / intelligence_eligibility
-- columns. Every object this file touches was created by 0191 and exists in
-- BOTH databases today (media_attachments.visibility_override is carried by the
-- 2026-08-19 production structure dump; census-media §12.5). So this file does
-- not depend on, pre-empt, or choose an order for that decision.
--
-- ── PRECONDITIONS REFUSE RATHER THAN HALF-APPLY ─────────────────────────────
-- Every existing row must already satisfy each CHECK. A violator is COUNTED and
-- named in the exception, and nothing is changed: rewriting somebody's stored
-- audience to make a constraint fit would be a privacy decision taken by DDL.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE bad_entity int; bad_override int; bad_visibility int;
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets missing — apply 0191_media_assets.sql first.';
  END IF;
  IF to_regclass('public.media_attachments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_attachments missing — apply 0191_media_assets.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets.version missing (0191 creates it).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'media_attachments' AND column_name = 'visibility_override') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_attachments.visibility_override missing (0191 creates it).';
  END IF;

  SELECT count(*) INTO bad_entity FROM public.media_attachments
   WHERE entity_type NOT IN ('post','postcard','memory','trip','place','event','hidden_gem','shared_moment','observation');
  IF bad_entity <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % media_attachments row(s) carry an entity_type outside the §6.1 nine; nothing was changed. Inspect them — they are links no reader can resolve.', bad_entity;
  END IF;

  SELECT count(*) INTO bad_override FROM public.media_attachments
   WHERE visibility_override IS NOT NULL
     AND visibility_override NOT IN ('inherit','public','followers','following','trip_crew','shared_moment','private');
  IF bad_override <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % media_attachments row(s) carry a visibility_override outside inherit + §33; nothing was changed. The reader denies these today; decide their audience deliberately before re-running.', bad_override;
  END IF;

  SELECT count(*) INTO bad_visibility FROM public.media_assets
   WHERE visibility NOT IN ('inherit','public','followers','following','trip_crew','shared_moment','private');
  IF bad_visibility <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % media_assets row(s) carry a visibility outside inherit + §33; nothing was changed.', bad_visibility;
  END IF;
END $$;

-- ── 1. §6.1 entity_type — the nine ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.media_attachments'::regclass
                   AND conname = 'media_attachments_entity_type_check') THEN
    ALTER TABLE public.media_attachments ADD CONSTRAINT media_attachments_entity_type_check
      CHECK (entity_type IN ('post','postcard','memory','trip','place','event',
                             'hidden_gem','shared_moment','observation'));
  END IF;
END $$;

-- ── 2. §6.1 visibility_override — NULL, inherit, or a §33 audience ───────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.media_attachments'::regclass
                   AND conname = 'media_attachments_visibility_override_check') THEN
    ALTER TABLE public.media_attachments ADD CONSTRAINT media_attachments_visibility_override_check
      CHECK (visibility_override IS NULL OR visibility_override IN
             ('inherit','public','followers','following','trip_crew','shared_moment','private'));
  END IF;
END $$;

-- ── 3. §6 / §33 media_assets.visibility — inherit or a §33 audience ─────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.media_assets'::regclass
                   AND conname = 'media_assets_visibility_check') THEN
    ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_visibility_check
      CHECK (visibility IN ('inherit','public','followers','following','trip_crew','shared_moment','private'));
  END IF;
END $$;

-- ── 4. §6 version — incremented by the database on every UPDATE ─────────────
-- search_path pinned empty: the body names no relation, only NEW/OLD.
CREATE OR REPLACE FUNCTION public.media_assets_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.media_assets_bump_version() FROM PUBLIC;

DROP TRIGGER IF EXISTS media_assets_version_bump ON public.media_assets;
CREATE TRIGGER media_assets_version_bump
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.media_assets_bump_version();

-- ── Postconditions — prove the shape landed, by definition text ─────────────
DO $$
DECLARE def text; v text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.media_attachments'::regclass AND conname = 'media_attachments_entity_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_attachments_entity_type_check not created';
  END IF;
  FOREACH v IN ARRAY ARRAY['post','postcard','memory','trip','place','event','hidden_gem','shared_moment','observation'] LOOP
    IF position(quote_literal(v) IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: entity_type CHECK does not admit %', v;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.media_attachments'::regclass AND conname = 'media_attachments_visibility_override_check';
  IF def IS NULL OR position('IS NULL' IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: visibility_override CHECK missing or no longer admits NULL (NULL = no override, the default)';
  END IF;
  FOREACH v IN ARRAY ARRAY['inherit','public','followers','following','trip_crew','shared_moment','private'] LOOP
    IF position(quote_literal(v) IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: visibility_override CHECK does not admit %', v;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.media_assets'::regclass AND conname = 'media_assets_visibility_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets_visibility_check not created';
  END IF;
  FOREACH v IN ARRAY ARRAY['inherit','public','followers','following','trip_crew','shared_moment','private'] LOOP
    IF position(quote_literal(v) IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.visibility CHECK does not admit %', v;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.media_assets'::regclass
                   AND tgname = 'media_assets_version_bump'
                   AND NOT tgisinternal
                   AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets_version_bump trigger missing or disabled';
  END IF;
END $$;

COMMIT;
