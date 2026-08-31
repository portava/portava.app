-- 2220_canonical_locations_search_key.sql
--
-- Global Input Intelligence — Phase 2 (Geographic Core). §10 diacritic/stroke
-- folding at the storage layer. POST-CUTOVER CANONICAL FORWARD MIGRATION
-- (2100-2999 band; Input lane 2220-2249).
--
-- WHY THIS EXISTS (the genuine correctness need)
-- ----------------------------------------------
-- Geographic resolution behind the input gateway matches a typed query against
-- canonical_locations. The stored comparison column is `normalized_name`, built
-- by lib/canonicalLocations.normalizeLocationName: NFD-decompose, strip combining
-- marks, lowercase, drop punctuation. That handles COMBINING diacritics — but a
-- Latin letter whose diacritic is a STROKE THROUGH the glyph (đ, Đ, ø, ł, …) has
-- NO Unicode decomposition. NFD leaves it whole, and the punctuation strip then
-- DELETES it, so the launch city "Đà Nẵng" was stored (and searched) as the
-- broken key "a nang" — which a typed "da nang" can never match. `unaccent` is
-- installed but unused, and there is no pg_trgm.
--
-- The fold cannot be applied to the existing stored `normalized_name` values in
-- code alone: those rows already LOST the stroke letter (Đ became a space at
-- insert time), so there is nothing left to re-fold. The correct key must be
-- recomputed from the intact display `name`, in the database, for every row —
-- which is what a generated column does, immediately and for all existing rows.
--
-- WHAT THIS ADDS (additive, idempotent, non-regressing)
-- -----------------------------------------------------
--   1. input_normalize_city_key(text) — an IMMUTABLE function that reproduces
--      normalizeLocationName EXACTLY, but folds stroke letters FIRST (translate)
--      so the base letter survives. Pure translate + normalize(NFD) + regexp;
--      no unaccent-dictionary dependency, so it is deterministic and mirrors the
--      TypeScript `searchKey()` byte-for-byte on the launch-city cases.
--   2. canonical_locations.search_key — a STORED generated column over `name`
--      using that function. Generated ⇒ every existing row is backfilled by the
--      ALTER itself and every future write stays consistent with zero app code.
--   3. pg_trgm + a GIN trigram index on search_key so the accent-insensitive
--      prefix/substring ILIKE the resolver runs is index-supported at scale.
--
-- The pre-existing `normalized_name` column, its index, and every route that
-- reads it are LEFT UNTOUCHED — non-geographic query paths do not change. Only
-- the new geographic resolver reads `search_key`, and it falls back to
-- `normalized_name` when the column is absent (pre-apply deploy window).
--
-- DEFERRED (not this migration): venue/place folding (places id-space is
-- separate — §5 landmine), semantic parsing (§18), live freshness (Phase 9).

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.canonical_locations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: canonical_locations is missing — apply 0125 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'canonical_locations' AND column_name = 'name'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: canonical_locations.name is missing.';
  END IF;
END $$;

-- ── 1. The immutable fold ────────────────────────────────────────────────────
-- Mirrors lib/canonicalLocations.searchKey(): strokeFold → NFD → strip combining
-- marks → lowercase → punctuation→space → collapse → strip generic city
-- prefixes/suffixes, never reducing to the empty string.
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

REVOKE ALL ON FUNCTION public.input_normalize_city_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.input_normalize_city_key(text) TO anon, authenticated, service_role;

-- ── 2. The generated search key (backfills every existing row) ───────────────
ALTER TABLE public.canonical_locations
  ADD COLUMN IF NOT EXISTS search_key text
  GENERATED ALWAYS AS (public.input_normalize_city_key(name)) STORED;

-- ── 3. Trigram index for accent-insensitive prefix/substring ILIKE ───────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS canonical_locations_search_key_trgm_idx
  ON public.canonical_locations USING gin (search_key gin_trgm_ops);

-- ── Postconditions (observed inside this txn; each raises only on failure) ────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'canonical_locations' AND column_name = 'search_key'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: search_key column was not created.';
  END IF;

  -- The Đ/đ fold — the whole point of this migration. If the fold regresses,
  -- this launch-city assertion fails the migration instead of silently
  -- reopening the "da nang" ≠ "Đà Nẵng" gap.
  IF public.input_normalize_city_key('Đà Nẵng') <> 'da nang' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Đà Nẵng folds to "%" (expected "da nang")',
      public.input_normalize_city_key('Đà Nẵng');
  END IF;
  -- Abbreviation targets resolve to a CITY key, not a country (§11): the "city"
  -- suffix strip must land Ho Chi Minh City on "ho chi minh".
  IF public.input_normalize_city_key('Ho Chi Minh City') <> 'ho chi minh' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Ho Chi Minh City folds to "%" (expected "ho chi minh")',
      public.input_normalize_city_key('Ho Chi Minh City');
  END IF;
  IF public.input_normalize_city_key('Cebu City') <> 'cebu' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Cebu City folds to "%" (expected "cebu")',
      public.input_normalize_city_key('Cebu City');
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;
--   ALTER TABLE public.canonical_locations DROP COLUMN IF EXISTS search_key;
--   DROP FUNCTION IF EXISTS public.input_normalize_city_key(text);
--   (pg_trgm is left installed; harmless.) Reversing REOPENS the §10 diacritic
--   gap — "da nang" stops matching stored "Đà Nẵng".
