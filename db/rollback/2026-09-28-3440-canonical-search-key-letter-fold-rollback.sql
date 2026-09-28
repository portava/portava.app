-- Rollback for 3440_canonical_search_key_letter_fold.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3440 DID
-- =============
-- Replaced 2220's public.input_normalize_city_key with the decompose-first fold,
-- then dropped and re-added canonical_locations.search_key (GENERATED ALWAYS …
-- STORED) so every stored key was recomputed, and rebuilt its trigram index.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- It is the file's REVERSAL footer, as a file: 2220's function body (copied byte
-- for byte from 2220_canonical_locations_search_key.sql), then DROP INDEX, DROP
-- COLUMN search_key, 2220's ADD COLUMN and CREATE INDEX, so every stored key is
-- recomputed under the old fold; then 3440's ledger row is deleted. The column is
-- generated, so no row's own data (name, normalized_name, display_name) changes.
-- It takes ACCESS EXCLUSIVE on canonical_locations and rewrites it, as 3440 did.
-- Reversing REOPENS census-discovery §66.5's defect ('Ǿresund' keys 'resund'
-- again). 2220's ACL on the function is unchanged by CREATE OR REPLACE.

BEGIN;

DO $pre$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3440): normalize(text, NFD) needs a UTF8 database.';
  END IF;
  IF to_regclass('public.canonical_locations') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3440): public.canonical_locations does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3440): pg_trgm is missing; 2220''s index needs it.';
  END IF;
END
$pre$;

-- 2220's function, verbatim.
CREATE OR REPLACE FUNCTION public.input_normalize_city_key(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $fn$
DECLARE
  v         text;
  v_strip   text;
BEGIN
  IF p_name IS NULL THEN
    RETURN NULL;
  END IF;

  -- Stroke/bar Latin letters that NFD does NOT decompose. Source and target
  -- strings are codepoint-aligned (14 chars each): đ Đ ø Ø ł Ł ħ Ħ ŧ Ŧ ð Ð ı İ.
  v := translate(p_name, 'đĐøØłŁħĦŧŦðÐıİ', 'ddoollhhttddii');

  -- Decompose remaining precomposed diacritics, then REMOVE the combining marks
  -- (U+0300..U+036F covers every Latin/Vietnamese tone mark). They must be
  -- deleted, not spaced — turning "à"→"a", never "a " (which would split words).
  v := normalize(v, NFD);
  v := regexp_replace(v, '[̀-ͯ]', '', 'g');

  v := lower(v);
  v := regexp_replace(v, '[^a-z0-9\s]', ' ', 'g'); -- punctuation → space
  v := regexp_replace(v, '\s+', ' ', 'g');         -- collapse whitespace
  v := btrim(v);

  -- Generic administrative prefixes/suffixes ("City of Manila" → "manila",
  -- "Cebu City" → "cebu"). Mirrors GENERIC_PREFIX / GENERIC_SUFFIX.
  v_strip := regexp_replace(v, '^(city|municipality|province|district|town) of ', '');
  v_strip := regexp_replace(v_strip, ' (city|municipality|metro)$', '');
  v_strip := btrim(v_strip);

  -- Never strip down to nothing.
  IF length(v_strip) > 0 THEN
    RETURN v_strip;
  END IF;
  RETURN v;
END
$fn$;

DROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;
ALTER TABLE public.canonical_locations DROP COLUMN IF EXISTS search_key;
-- 2220's column and index, verbatim.
ALTER TABLE public.canonical_locations
  ADD COLUMN IF NOT EXISTS search_key text
  GENERATED ALWAYS AS (public.input_normalize_city_key(name)) STORED;
CREATE INDEX IF NOT EXISTS canonical_locations_search_key_trgm_idx
  ON public.canonical_locations USING gin (search_key gin_trgm_ops);

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3440_canonical_search_key_letter_fold.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF public.input_normalize_city_key('Đà Nẵng') <> 'da nang'
     OR public.input_normalize_city_key('Ho Chi Minh City') <> 'ho chi minh'
     OR public.input_normalize_city_key('Cebu City') <> 'cebu' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440 rollback): one of 2220''s three launch keys moved.';
  END IF;
  IF public.input_normalize_city_key('Ǿresund') <> 'resund' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440 rollback): the function is not 2220''s (Ǿresund keys %).', public.input_normalize_city_key('Ǿresund');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'canonical_locations'
                   AND column_name = 'search_key' AND is_generated = 'ALWAYS')
     OR to_regclass('public.canonical_locations_search_key_trgm_idx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440 rollback): 2220''s generated search_key or its index is missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.canonical_locations WHERE search_key IS DISTINCT FROM public.input_normalize_city_key(name)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440 rollback): a stored search_key was not recomputed under 2220''s fold.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3440_canonical_search_key_letter_fold.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440 rollback): the ledger still records 3440 as applied.';
  END IF;
END $post$;
