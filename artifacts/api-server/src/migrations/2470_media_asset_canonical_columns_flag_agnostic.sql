-- 2470_media_asset_canonical_columns_flag_agnostic.sql
--
-- The migration-2250 column set for `media_assets`, re-issued WITHOUT 2250's
-- postcondition that `media_canonical_enabled` is FALSE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2470.
-- NOT APPLIED ANYWHERE. Written 2026-09-07 for the owner to run by hand, and
-- only after the owner decision recorded under OWNER DECISION REQUIRED:
-- MEDIA_CANONICAL_FLAG. Rollback: db/rollback/2026-09-07-2470-media-asset-canonical-columns-rollback.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS WHEN 2250 ALREADY DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- Measured 2026-09-07:
--
--                                          production (ajrurzioarfkagpuxfnb)   portava-ci (hwokxgbmezheskbzskfr)
--   media_assets columns                   23                                  27
--   2250 applied                           NO                                  YES
--   feature_flags.media_canonical_enabled  TRUE                                no row (-> false)
--   media_assets rows                      8 (2026-07-25 .. 2026-08-16)        0
--
-- `lib/mediaAssets.recordMediaAssetDetailed` names captured_at, provenance and
-- intelligence_eligibility in every upsert. A rolled-back INSERT with exactly
-- that column list against production returns SQLSTATE 42703
-- (`column "captured_at" of relation "media_assets" does not exist`). So with
-- the flag TRUE the writer has been rejected on every upload since 2026-08-16.
--
-- 2250 as written CANNOT be applied to production while the flag is TRUE: its
-- final postcondition is
--
--     IF EXISTS (SELECT 1 FROM public.feature_flags
--                 WHERE flag='media_canonical_enabled' AND enabled=TRUE)
--     THEN RAISE EXCEPTION 'POSTCONDITION FAILED: media_canonical_enabled is ON …'
--
-- inside BEGIN … COMMIT, so the whole transaction rolls back and the columns
-- are not created. That leaves the owner two orders, both correct, and this
-- file serves the second:
--
--   ORDER A (no new migration)  set media_canonical_enabled = FALSE
--                               -> apply 2250 as written
--                               -> verify (POST checks below)
--                               -> set media_canonical_enabled = TRUE (or not)
--
--   ORDER B (this file)         leave the flag as it is
--                               -> apply 2470
--                               -> verify (POST checks below)
--
-- Under ORDER B the writer resumes on the next probe cycle (≤ 30 s, see
-- lib/media/mediaSchemaCapability) with NO code change and NO flag change —
-- which is why this file must not be run before the decision is taken: it
-- would light the canonical write path in production as a side effect of DDL,
-- and `media_assets` is read by lib/mediaAccess (owner attribution), the §18
-- Quick Media row and the §30 Uploads count.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES — byte-for-byte the DDL of 2250 §1-§4, idempotent
-- ══════════════════════════════════════════════════════════════════════════════
--   1. captured_at TIMESTAMPTZ; location_visibility TEXT NOT NULL DEFAULT 'hidden'
--      + CHECK; provenance JSONB; intelligence_eligibility JSONB.
--   2. media_assets_source_type_check (§6 8-value set + legacy 'user').
--   3. moderation_status CHECK replaced by the canonical superset
--      (processing|active|limited|rejected|removed|owner_deleted + legacy
--      pending|approved|flagged). Production's 8 rows are all 'pending' and
--      stay valid.
--   4. media_attachments position / is_cover / visibility_override asserted.
--
-- On portava-ci, where 2250 already ran, every statement is a no-op and the
-- postconditions pass; applying it there records the lane in the ledger only.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRE-APPLY VERIFICATION (run first; expected values in comments)
-- ══════════════════════════════════════════════════════════════════════════════
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='media_assets'
--      AND column_name IN ('captured_at','location_visibility','provenance','intelligence_eligibility');
--   -- production: 0    portava-ci: 4
--
--   SELECT flag, enabled FROM public.feature_flags WHERE flag='media_canonical_enabled';
--   -- production: TRUE  (this file does not read or change it)
--
--   SELECT moderation_status, count(*) FROM public.media_assets GROUP BY 1;
--   -- production: pending 8 — every value must be in the widened CHECK below
--
-- ══════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════════
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='media_assets'
--      AND column_name IN ('captured_at','location_visibility','provenance','intelligence_eligibility');
--   -- must be 4
--
--   SELECT conname FROM pg_constraint WHERE conrelid='public.media_assets'::regclass AND contype='c'
--    ORDER BY 1;
--   -- must include media_assets_source_type_check AND media_assets_moderation_status_canonical_check
--   -- and must NOT include media_assets_moderation_status_check
--
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='media_assets' AND column_name='location_visibility';
--   -- 'hidden'::text
--
--   SELECT flag, enabled FROM public.feature_flags WHERE flag='media_canonical_enabled';
--   -- unchanged from PRE
--
--   -- Then watch the api logs: the next upload must log NO
--   -- "canonical write REFUSED — schema-capability guard" line, and
--   -- SELECT count(*), max(created_at) FROM public.media_assets; must grow.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets missing — apply 0191_media_assets.sql first.';
  END IF;
  IF to_regclass('public.media_attachments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_attachments missing — apply 0191_media_assets.sql first.';
  END IF;
  -- Every existing moderation_status value must be admitted by the widened
  -- CHECK, or the ADD CONSTRAINT below would fail half way through §3.
  IF EXISTS (
    SELECT 1 FROM public.media_assets
     WHERE moderation_status NOT IN (
       'processing','active','limited','rejected','removed','owner_deleted',
       'pending','approved','flagged')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets carries a moderation_status outside the canonical superset';
  END IF;
END $$;

-- ── 1. §6 columns (idempotent) ───────────────────────────────────────────────
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS location_visibility TEXT NOT NULL DEFAULT 'hidden'
  CHECK (location_visibility IN ('hidden','country','city','neighborhood','place','precise_private'));

ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS provenance JSONB;

ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS intelligence_eligibility JSONB;

-- ── 2. source_type → §6 8-value set (+ legacy 'user'), non-destructive ────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_assets'::regclass
      AND contype = 'c'
      AND conname = 'media_assets_source_type_check'
  ) THEN
    ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_source_type_check
      CHECK (source_type IN (
        'camera','library','provider','official',
        'community','generated','screenshot','derivative',
        'user'
      ));
  END IF;
END $$;

-- ── 3. moderation_status → canonical superset (legacy + §36) ──────────────────
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.media_assets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%moderation_status%'
    AND conname <> 'media_assets_moderation_status_canonical_check';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.media_assets DROP CONSTRAINT %I', cname);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_assets'::regclass
      AND conname = 'media_assets_moderation_status_canonical_check'
  ) THEN
    ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_moderation_status_canonical_check
      CHECK (moderation_status IN (
        'processing','active','limited','rejected','removed','owner_deleted',
        'pending','approved','flagged'
      ));
  END IF;
END $$;

-- ── 4. §6.1 media_attachments columns (assert present; 0191 created them) ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='position') THEN
    ALTER TABLE public.media_attachments ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='is_cover') THEN
    ALTER TABLE public.media_attachments ADD COLUMN is_cover BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='visibility_override') THEN
    ALTER TABLE public.media_attachments ADD COLUMN visibility_override TEXT;
  END IF;
END $$;

-- ── Postconditions — the shape, the defaults; NOT the flag ───────────────────
DO $$
DECLARE
  loc_default text;
  n_cols integer;
  flag_state boolean;
BEGIN
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='media_assets'
     AND column_name IN ('captured_at','location_visibility','provenance','intelligence_eligibility');
  IF n_cols <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 4 migration-2250 columns on media_assets, found %', n_cols;
  END IF;

  SELECT column_default INTO loc_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='media_assets' AND column_name='location_visibility';
  IF loc_default IS NULL OR loc_default NOT LIKE '''hidden''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: location_visibility default is % — must be ''hidden''', loc_default;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_source_type_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: source_type CHECK not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_moderation_status_canonical_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation_status canonical CHECK not created';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid='public.media_assets'::regclass AND conname='media_assets_moderation_status_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: legacy moderation_status CHECK still present';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='public.media_assets'::regclass
        AND conname='media_assets_moderation_status_canonical_check') NOT LIKE '%''approved''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moderation CHECK dropped the legacy served state ''approved''';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='media_attachments' AND column_name='visibility_override') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_attachments.visibility_override missing';
  END IF;

  -- The one thing this file deliberately does NOT assert: the flag. It is the
  -- owner's, it is TRUE in production, and this file neither reads it into a
  -- verdict nor changes it. It is reported so the apply log shows what the
  -- writer will do next.
  SELECT enabled INTO flag_state FROM public.feature_flags WHERE flag = 'media_canonical_enabled';
  IF flag_state IS NULL THEN
    RAISE NOTICE 'media_canonical_enabled has no row here (reads as false): canonical writes stay off';
  ELSIF flag_state THEN
    RAISE NOTICE 'media_canonical_enabled is TRUE here: the canonical writer will RESUME within one probe cycle';
  ELSE
    RAISE NOTICE 'media_canonical_enabled is FALSE here: canonical writes stay off until it is turned on';
  END IF;
END $$;

COMMIT;
