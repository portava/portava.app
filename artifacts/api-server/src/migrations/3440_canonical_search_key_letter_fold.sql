-- 3440_canonical_search_key_letter_fold.sql
-- census-discovery §73 (lane P27), widened by §77 (lane P35): B01 and DV-20, the letter fold completed on
-- the STORED side. Replaces 2220's input_normalize_city_key and RECOMPUTES
-- canonical_locations.search_key.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it: NOT portava-ci, NOT production. Rehearsed
-- on the local PostgreSQL 16 harness only, if census-discovery §73 says so.
-- 2220 IS applied to production, so this needs the owner's approval: applying it
-- REWRITES every row's stored search_key (census-discovery §73, approval item A).
--
-- ── THE DEFECT (census-discovery §66.5, §66.11) ─────────────────────────────
-- 2220 translates fourteen stroke letters BEFORE normalize(NFD). Ǿ and ǿ are Ø/ø
-- plus a combining acute, so their Ø surfaces only after the translate has run,
-- and the punctuation strip then deletes it: 'Øresund' keys 'oresund' and
-- 'Ǿresund' keys 'resund'. The hooked, barred and curled letters (ƀ Ɓ ƙ ȥ Ɏ …)
-- have no entry at all and are deleted the same way.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- normalize(NFD) FIRST, then the table, which is lib/latinLetterFold's
-- LATIN_LETTER_FOLD (lib/canonicalLocations.STROKE_FOLD): every Latin letter
-- named "LATIN … LETTER X WITH …" (or BARRED X / X BAR) folds as X does, with the
-- other case of each, ſ, ı, and 2220's eth and İ; Ŀ ŀ ẚ ᵺ go to a two-letter
-- spelling (l·, aʾ, th) by replace(). The translate strings are codepoint-aligned
-- (253 each). ß æ œ þ ŋ are NOT folded:
-- census-discovery §66.9 owner question 4 is open, and the postcondition below
-- pins that this migration leaves them as 2220 did.
-- src/test/discoveryLetterFoldCompleteness.test.ts L7 pins this table to the
-- TypeScript; src/test/db/discoverySearchCanonicalFold.db.test.ts K5 runs both
-- over every enumerated letter.
--
-- ── WHY THE COLUMN IS DROPPED AND RE-ADDED ──────────────────────────────────
-- search_key is GENERATED ALWAYS … STORED. Replacing the function does NOT
-- rewrite values already stored, so a row named 'Ǿresund' would keep 'resund'
-- while every query folds to 'oresund'. PostgreSQL 16 has no ALTER COLUMN … SET
-- EXPRESSION, so the column is dropped (its trigram index goes with it) and
-- re-added, which recomputes every row, and the index is rebuilt. The ADD takes
-- an ACCESS EXCLUSIVE lock and rewrites canonical_locations; readers of
-- search_key already degrade to normalized_name, and MARK it, while the column is
-- absent (lib/discoverySearchCanonical.ts, db test K4).

BEGIN;

DO $pre$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3440): normalize(text, NFD) needs a UTF8 database; this one is %.', current_setting('server_encoding');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'canonical_locations'
                    AND column_name = 'search_key' AND is_generated = 'ALWAYS') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3440): canonical_locations.search_key is not 2220''s generated column. Apply 2220 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3440): pg_trgm is missing; 2220 installs it.';
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;
ALTER TABLE public.canonical_locations DROP COLUMN search_key;

-- lib/canonicalLocations.searchKey: NFD → stroke/hook/bar table → strip the
-- four Latin mark blocks (§77) → lowercase → punctuation→space → collapse → strip generic city
-- prefixes/suffixes, never reducing to the empty string. Everything after the
-- table is 2220's, unchanged.
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

  v := translate(normalize(p_name, NFD), 'ÐØðøĐđĦħıŁłŦŧſƀƁƂƃƇƈƉƊƋƌƑƒƓƗƘƙƚƝƞƟƤƥƫƬƭƮƲƳƴƵƶǄǆǤǥȠȡȤȥȴȵȶȺȻȼȽȾȿɀɃɄɆɇɈɉɊɋɌɍɎɏɓɕɖɗɠɦɨɫɬɭɱɲɳɵɼɽɾʂʈʉʋʐʑʝʠᵬᵭᵮᵯᵰᵱᵲᵳᵴᵵᵶᵽᶀᶁᶂᶃᶄᶅᶆᶇᶈᶉᶊᶌᶍᶎᶏᶑᶒᶖᶙẜẝỾỿⱠⱡⱢⱣⱤⱥⱦⱧⱨⱩⱪⱫⱬⱮⱱⱲⱳⱴⱸⱺⱾⱿꝀꝁꝂꝃꝄꝅꝈꝉꝊꝋꝌꝍꝐꝑꝒꝓꝔꝕꝖꝗꝘꝙꝞꝟꝤꝥꝦꝧꞎꞐꞑꞒꞓꞔꞕꞖꞗꞘꞙꞠꞡꞢꞣꞤꞥꞦꞧꞨꞩꞪꞭꞲꞸꞹꟄꟅꟆꟇꟈꟉꟊꟌꟍꬳꬴꬷꬸꬹꬺꬻꬼꭉꭎꭏꭒꭖꭗꭘꭙꭚ𝼉𝼑𝼓𝼔𝼖𝼚𝼛𝼝𝼞𝼥𝼦𝼧𝼨𝼩𝼪İ', 'dododdhhillttsbbbbccddddffgikklnnoppttttvyyzzǱǳggndzzlntaccltszbueejjqqrryybcddghilllmnnorrrstuvzzjqbdfmnprrstzpbdfgklmnprsvxzadeiussyylllprathhkkzzmvwwveoszkkkkkkllooooppppppqqqqvvÞþÞþlnnccchbbffggkknnrrsshljuucszddsssseelllmnŋruuuxxxxytllŋriocsdlnrsti');
  v := replace(replace(replace(replace(v, 'Ŀ', 'l·'), 'ŀ', 'l·'), 'ẚ', 'aʾ'), 'ᵺ', 'th');
  v := regexp_replace(v, '[' || chr(768) || '-' || chr(879) || chr(6832) || '-' || chr(6911) || chr(7616) || '-' || chr(7679) || chr(65056) || '-' || chr(65071) || ']', '', 'g');
  -- §77: U+0300–U+036F, U+1AB0–U+1AFF, U+1DC0–U+1DFF, U+FE20–U+FE2F, each whole (lib/latinLetterFold.LATIN_MARK_BLOCKS).
  v := lower(v);
  v := regexp_replace(v, '[^a-z0-9\s]', ' ', 'g'); -- punctuation → space
  v := regexp_replace(v, '\s+', ' ', 'g');         -- collapse whitespace
  v := btrim(v);

  v_strip := regexp_replace(v, '^(city|municipality|province|district|town) of ', '');
  v_strip := regexp_replace(v_strip, ' (city|municipality|metro)$', '');
  v_strip := btrim(v_strip);

  IF length(v_strip) > 0 THEN
    RETURN v_strip;
  END IF;
  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public.input_normalize_city_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.input_normalize_city_key(text) TO anon, authenticated, service_role;

ALTER TABLE public.canonical_locations
  ADD COLUMN search_key text
  GENERATED ALWAYS AS (public.input_normalize_city_key(name)) STORED;

CREATE INDEX canonical_locations_search_key_trgm_idx
  ON public.canonical_locations USING gin (search_key gin_trgm_ops);

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'canonical_locations'
                    AND column_name = 'search_key' AND is_generated = 'ALWAYS') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): search_key was not re-added as a generated column.';
  END IF;
  IF to_regclass('public.canonical_locations_search_key_trgm_idx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): the trigram index was not rebuilt.';
  END IF;
  -- 2220's own three, unchanged.
  IF public.input_normalize_city_key('Đà Nẵng') <> 'da nang'
     OR public.input_normalize_city_key('Ho Chi Minh City') <> 'ho chi minh'
     OR public.input_normalize_city_key('Cebu City') <> 'cebu' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): a 2220 launch-city key regressed.';
  END IF;
  -- The defect, closed: Ǿ is Ø + acute, and a hooked letter is its letter.
  IF public.input_normalize_city_key('Ǿresund') <> 'oresund'
     OR public.input_normalize_city_key('ǿresund') <> 'oresund'
     OR public.input_normalize_city_key('Ƀerlin') <> 'berlin' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): Ǿresund folds to "%" (expected "oresund").',
      public.input_normalize_city_key('Ǿresund');
  END IF;
  -- Owner question 4 is NOT decided here: ß is deleted exactly as 2220 deleted it.
  IF public.input_normalize_city_key('Straße') <> 'stra e' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): ß changed its fold; census-discovery §66.9 Q4 is open.';
  END IF;
  -- §77 (lane P35): a combining diacritic from the three Latin blocks beyond U+036F folds away,
  -- as one from U+0300–U+036F always did: ALA-LC's half-mark tie, and macron-acute (U+1DC4).
  IF public.input_normalize_city_key('I' || chr(65056) || 'A' || chr(65057) || 'roslavl') <> 'iaroslavl'
     OR public.input_normalize_city_key('Zu' || chr(7620) || 'rich') <> 'zurich'
     OR public.input_normalize_city_key('Zu' || chr(6832) || 'rich') <> 'zurich' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3440): I︠A︡roslavl folds to "%" (expected "iaroslavl").',
      public.input_normalize_city_key('I' || chr(65056) || 'A' || chr(65057) || 'roslavl');
  END IF;
END
$post$;

COMMIT;

-- REVERSAL: re-run 2220's function body (translate BEFORE normalize(NFD), the
-- fourteen letters), then DROP INDEX canonical_locations_search_key_trgm_idx,
-- DROP COLUMN search_key and re-run 2220's ADD COLUMN and CREATE INDEX, so the
-- stored keys are recomputed under the old fold. Reversing REOPENS §66.5's gap.
--
-- §77 (lane P35) AMENDED THIS FILE IN PLACE, before it reached any database but
-- the local harness: line 83's mark strip now covers the four Latin combining
-- blocks, not only U+0300–U+036F, and the postcondition above pins it. A row whose
-- name carries one of those marks ("I︠A︡roslavl") is stored as its letters
-- ('iaroslavl'), not as a word break ('i a roslavl'). Approval item A is
-- unchanged in kind: applying this file to production still REWRITES every
-- row's stored search_key (census-discovery §73.8, §77).
