-- Rollback for 3441_trail_letter_fold_decompose_first.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3441 DID
-- =============
-- Replaced 3415's trail_letter_fold, trail_canonical_slug and
-- trail_normalised_destination with the decompose-first fold; recomputed
-- trails.slug where it differed from the new canonical slug; added the generated
-- column trails.destination_key and idx_trails_destination_key.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- It is the file's REVERSAL footer, as a file, in the footer's order: the index
-- and the column FIRST (the column depends on trail_normalised_destination, and
-- 3415's rollback cannot drop that function while it exists), then 3415's three
-- function bodies, copied byte for byte from 3415_trail_proposal_serialised.sql,
-- then 3441's ledger row. 3415's REVOKE/GRANT on the three are unchanged by
-- CREATE OR REPLACE. destination_key is generated, so dropping it loses no data.
-- STORED SLUGS ARE NOT REWRITTEN BACK (the footer says so): the pre-3441 slugs
-- were overwritten by 3441 and nothing recorded them. A NOTICE counts the Trails
-- whose slug now differs from the restored fold's; a later migration recomputes
-- them. TrailService.listTrails answers a destination filter with 503 while the
-- column is absent (census-discovery §77), never a string match. Reversing
-- REOPENS §66.11's and §74's gaps.

BEGIN;

DO $pre$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3441): normalize(text, NFD) needs a UTF8 database.';
  END IF;
  IF to_regclass('public.trails') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3441): public.trails does not exist.';
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_trails_destination_key;
ALTER TABLE public.trails DROP COLUMN IF EXISTS destination_key;

-- 3415's three functions, verbatim.
CREATE OR REPLACE FUNCTION public.trail_letter_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
           translate(p_text, 'đĐøØłŁħĦŧŦðÐıİ', 'ddoollhhttddii'),
           'ß', 'ss'), 'ẞ', 'ss'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'), 'þ', 'th'), 'Þ', 'th'), 'ŋ', 'ng'), 'Ŋ', 'ng')
$fn$;

CREATE OR REPLACE FUNCTION public.trail_canonical_slug(p_title text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
  SELECT NULLIF(
    regexp_replace(
      regexp_replace(
        translate(
          regexp_replace(normalize(public.trail_letter_fold(p_title), NFKD),
                         '[' || chr(768) || '-' || chr(879) || ']', '', 'g'),
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'),
      '^-+|-+$', '', 'g'),
    '')
$fn$;

CREATE OR REPLACE FUNCTION public.trail_normalised_destination(p_destination text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v text;
  v_strip text;
BEGIN
  IF p_destination IS NULL THEN
    RETURN NULL;
  END IF;
  v := public.trail_letter_fold(p_destination);
  v := regexp_replace(normalize(v, NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g');
  v := translate(v, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  v := btrim(regexp_replace(v, '[^abcdefghijklmnopqrstuvwxyz0123456789]+', ' ', 'g'), ' ');
  v_strip := regexp_replace(v, '^(city|municipality|province|district|town) of ', '');
  v_strip := btrim(regexp_replace(v_strip, ' (city|municipality|metro)$', ''), ' ');
  IF length(v_strip) > 0 THEN
    RETURN v_strip;
  END IF;
  RETURN NULLIF(v, '');
END;
$fn$;

DO $slug$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.trails WHERE slug IS DISTINCT FROM public.trail_canonical_slug(title);
  IF n > 0 THEN
    RAISE NOTICE '3441 rollback: % Trail slug(s) were recomputed by 3441 and are not rewritten back; they differ from the restored fold''s slug until a migration recomputes them.', n;
  END IF;
END
$slug$;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3441_trail_letter_fold_decompose_first.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trails' AND column_name = 'destination_key')
     OR to_regclass('public.idx_trails_destination_key') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441 rollback): destination_key or its index still exists.';
  END IF;
  IF to_regprocedure('public.trail_letter_fold(text)') IS NULL
     OR to_regprocedure('public.trail_canonical_slug(text)') IS NULL
     OR to_regprocedure('public.trail_normalised_destination(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441 rollback): one of 3415''s three fold functions is missing.';
  END IF;
  IF public.trail_canonical_slug('Øresund cycling') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441 rollback): trail_canonical_slug answers NULL for a plain title.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3441_trail_letter_fold_decompose_first.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441 rollback): the ledger still records 3441 as applied.';
  END IF;
END $post$;
