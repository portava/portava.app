-- 3441_trail_letter_fold_decompose_first.sql
-- census-discovery §73 (lane P27): DV-20, the Trail letter fold decomposes
-- FIRST and carries the whole stroke/hook/bar table (replaces 3415's
-- trail_letter_fold). §77 (lane P35) amended it: trail_canonical_slug and
-- trail_normalised_destination strip all four Latin mark blocks, stored
-- trails.slug is RECOMPUTED, and trails.destination_key is added (§77 below).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lanes that wrote it: NOT portava-ci, NOT production (3415 is
-- in neither). Rehearsed on the local PostgreSQL 16 harness only, if
-- census-discovery §73/§77 say so. Since §77 it WRITES public.trails (below).
--
-- ── THE DEFECT (census-discovery §66.11) ────────────────────────────────────
-- 3415 translated the fourteen stroke letters of the RAW title, then the slug
-- decomposed (NFKD). So Ǿ (Ø + acute) never met the table, 'Ǿresund cycling'
-- slugged 'resund-cycling' beside 'Øresund cycling''s 'oresund-cycling', and the
-- hooked and barred letters (Ƀ Ƙ ȥ …) had no entry: 114 of the 398 Latin letters
-- in U+00C0–U+024F were deleted, and two spellings of one theme became two
-- canonical Trails.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- normalize(NFD) first, then lib/latinLetterFold's table (the one 3440 gives
-- input_normalize_city_key: 253 codepoint-aligned letters, plus Ŀ ŀ ẚ ᵺ to a
-- two-letter spelling), then 3415's letter fold, unchanged: ß ẞ → ss,
-- æ Æ → ae, œ Œ → oe, þ Þ → th, ŋ Ŋ → ng. Because the letter fold now also sees
-- decomposed text, ǽ Ǽ ǣ Ǣ (æ with a mark) fold as æ does. The result is in NFD;
-- both callers normalise again, so the slug and the destination key equal
-- lib/discoveryTrailObject's (src/test/db/trailsProposalRace.db.test.ts G1e).

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.trail_letter_fold(text)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3441): public.trail_letter_fold(text) does not exist. Apply 3415 first.';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3441): normalize(text, NFD) needs a UTF8 database; this one is %.', current_setting('server_encoding');
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trail_letter_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(
             translate(normalize(p_text, NFD), 'ÐØðøĐđĦħıŁłŦŧſƀƁƂƃƇƈƉƊƋƌƑƒƓƗƘƙƚƝƞƟƤƥƫƬƭƮƲƳƴƵƶǄǆǤǥȠȡȤȥȴȵȶȺȻȼȽȾȿɀɃɄɆɇɈɉɊɋɌɍɎɏɓɕɖɗɠɦɨɫɬɭɱɲɳɵɼɽɾʂʈʉʋʐʑʝʠᵬᵭᵮᵯᵰᵱᵲᵳᵴᵵᵶᵽᶀᶁᶂᶃᶄᶅᶆᶇᶈᶉᶊᶌᶍᶎᶏᶑᶒᶖᶙẜẝỾỿⱠⱡⱢⱣⱤⱥⱦⱧⱨⱩⱪⱫⱬⱮⱱⱲⱳⱴⱸⱺⱾⱿꝀꝁꝂꝃꝄꝅꝈꝉꝊꝋꝌꝍꝐꝑꝒꝓꝔꝕꝖꝗꝘꝙꝞꝟꝤꝥꝦꝧꞎꞐꞑꞒꞓꞔꞕꞖꞗꞘꞙꞠꞡꞢꞣꞤꞥꞦꞧꞨꞩꞪꞭꞲꞸꞹꟄꟅꟆꟇꟈꟉꟊꟌꟍꬳꬴꬷꬸꬹꬺꬻꬼꭉꭎꭏꭒꭖꭗꭘꭙꭚ𝼉𝼑𝼓𝼔𝼖𝼚𝼛𝼝𝼞𝼥𝼦𝼧𝼨𝼩𝼪İ', 'dododdhhillttsbbbbccddddffgikklnnoppttttvyyzzǱǳggndzzlntaccltszbueejjqqrryybcddghilllmnnorrrstuvzzjqbdfmnprrstzpbdfgklmnprsvxzadeiussyylllprathhkkzzmvwwveoszkkkkkkllooooppppppqqqqvvÞþÞþlnnccchbbffggkknnrrsshljuucszddsssseelllmnŋruuuxxxxytllŋriocsdlnrsti'),
           'Ŀ', 'l·'), 'ŀ', 'l·'), 'ẚ', 'aʾ'), 'ᵺ', 'th'),
           'ß', 'ss'), 'ẞ', 'ss'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'), 'þ', 'th'), 'Þ', 'th'), 'ŋ', 'ng'), 'Ŋ', 'ng')
$fn$;

-- ── §77 (lane P35, census-discovery DV-20): every Latin combining diacritic ────
-- §74 (lane P32) found both callers of the letter fold stripping U+0300–U+036F
-- only. A mark from U+1AB0–U+1AFF, U+1DC0–U+1DFF or U+FE20–U+FE2F (91 of them
-- carry Unicode's Diacritic property) became a word break: 'I︠A︡roslavl street
-- food' (ALA-LC's tie, as the half marks U+FE20/U+FE21) slugged
-- 'i-a-roslavl-street-food' beside 'Iaroslavl street food', and trail_propose
-- admitted both. Both callers are re-created below with 3415's bodies, unchanged
-- except that the strip covers the four blocks WHOLE, as lib/latinLetterFold's
-- LATIN_MARK_BLOCKS does (src/test/discoveryLetterFoldCompleteness.test.ts L10
-- pins the ranges; L9 checks the rule over every code point).
--
-- A fold that changes must reach what was stored under the old one, so also:
--   1. trails.destination_key, GENERATED ALWAYS AS
--      trail_normalised_destination(destination) STORED and indexed with
--      lifecycle_status. TrailService.listTrails filters a destination by it, so
--      "Đà Nẵng" lists the Trails filed under "da nang" (§74's second ground).
--      It is dropped first and re-added last, as 3440 does search_key, so every
--      run of this file recomputes it under the functions it has just replaced.
--   2. trails.slug is RECOMPUTED from the title (§74.4 #2). As P27 wrote it, this
--      file replaced the function and rewrote no row, so a Trail stored under
--      3415's fold stayed outside a re-spelling's comparison set. If two Trails
--      would share one slug, or one would have none, the file STOPS and names
--      them: merging Trails is an owner's decision, not a migration's. Changing
--      rows go through a unique temporary slug first, so no UNIQUE (slug) check
--      can fire on a slug another changing row is about to give up.
--   Re-running 2910 after this file refuses (2910 compares trails' columns
--   EXACTLY, and destination_key is not in its list): roll this file back first.
DROP INDEX IF EXISTS public.idx_trails_destination_key;
ALTER TABLE public.trails DROP COLUMN IF EXISTS destination_key;

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
                         '[' || chr(768) || '-' || chr(879) || chr(6832) || '-' || chr(6911) || chr(7616) || '-' || chr(7679) || chr(65056) || '-' || chr(65071) || ']', '', 'g'),
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
  v := regexp_replace(normalize(v, NFD), '[' || chr(768) || '-' || chr(879) || chr(6832) || '-' || chr(6911) || chr(7616) || '-' || chr(7679) || chr(65056) || '-' || chr(65071) || ']', '', 'g');
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
DECLARE
  v_clash text;
  v_none  text;
BEGIN
  WITH k AS (SELECT id, public.trail_canonical_slug(title) AS slug FROM public.trails)
  SELECT string_agg(format('%s (%s)', g.slug, g.ids), '; ') INTO v_clash
    FROM (SELECT slug, string_agg(id::text, ', ' ORDER BY id) AS ids FROM k
           WHERE slug IS NOT NULL GROUP BY slug HAVING count(*) > 1) AS g;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3441): recomputing trails.slug would give two Trails one slug: %. Retitle or merge them first; merging Trails is the owner''s decision.', v_clash;
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_none
    FROM public.trails WHERE public.trail_canonical_slug(title) IS NULL;
  IF v_none IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3441): these Trails'' titles have no slug under the current fold: %.', v_none;
  END IF;
END
$slug$;

UPDATE public.trails
   SET slug = 'p3441-' || replace(id::text, '-', '')
 WHERE slug IS DISTINCT FROM public.trail_canonical_slug(title);
UPDATE public.trails
   SET slug = public.trail_canonical_slug(title)
 WHERE slug LIKE 'p3441-%' AND slug = 'p3441-' || replace(id::text, '-', '');

ALTER TABLE public.trails
  ADD COLUMN destination_key text
  GENERATED ALWAYS AS (public.trail_normalised_destination(destination)) STORED;
CREATE INDEX idx_trails_destination_key ON public.trails (destination_key, lifecycle_status);
COMMENT ON COLUMN public.trails.destination_key IS
  'census-discovery §77 (DV-20): trail_normalised_destination(destination), the key the creation checks compare. GET /v1/discovery/trails filters a destination by it, never by the stored spelling.';

DO $post$
BEGIN
  IF public.trail_canonical_slug('Ǿresund cycling') IS DISTINCT FROM 'oresund-cycling'
     OR public.trail_canonical_slug('Øresund cycling') IS DISTINCT FROM 'oresund-cycling'
     OR public.trail_canonical_slug('Ƀerlin street art') IS DISTINCT FROM 'berlin-street-art'
     OR public.trail_canonical_slug('Đà Nẵng street food') IS DISTINCT FROM 'da-nang-street-food'
     OR public.trail_canonical_slug('Straße Food') IS DISTINCT FROM 'strasse-food' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441): Ǿresund cycling slugs to "%".', public.trail_canonical_slug('Ǿresund cycling');
  END IF;
  IF public.trail_normalised_destination('Ǿresund') IS DISTINCT FROM 'oresund' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441): the destination Ǿresund keys "%".', public.trail_normalised_destination('Ǿresund');
  END IF;
  -- §77: the three Latin mark blocks beyond U+036F fold away, in the slug and in the destination key.
  IF public.trail_canonical_slug('I' || chr(65056) || 'A' || chr(65057) || 'roslavl street food') IS DISTINCT FROM 'iaroslavl-street-food'
     OR public.trail_canonical_slug('Zu' || chr(7620) || 'rich coffee') IS DISTINCT FROM 'zurich-coffee'
     OR public.trail_normalised_destination('I' || chr(65056) || 'A' || chr(65057) || 'roslavl') IS DISTINCT FROM 'iaroslavl'
     OR public.trail_normalised_destination('Zu' || chr(6832) || 'rich') IS DISTINCT FROM 'zurich' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441): I︠A︡roslavl street food slugs to "%".',
      public.trail_canonical_slug('I' || chr(65056) || 'A' || chr(65057) || 'roslavl street food');
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE slug IS DISTINCT FROM public.trail_canonical_slug(title)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441): a stored trails.slug is not its title''s slug under the current fold.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trails'
                    AND column_name = 'destination_key' AND is_generated = 'ALWAYS')
     OR to_regclass('public.idx_trails_destination_key') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3441): trails.destination_key or its index is missing.';
  END IF;
END
$post$;

COMMIT;

-- REVERSAL: DROP INDEX public.idx_trails_destination_key and ALTER TABLE
-- public.trails DROP COLUMN destination_key FIRST (it depends on
-- trail_normalised_destination, and 2910's exact column check refuses it), then
-- re-run 3415's CREATE OR REPLACE FUNCTION public.trail_letter_fold (translate of
-- the raw text, fourteen letters), public.trail_canonical_slug and
-- public.trail_normalised_destination (U+0300–U+036F only). Stored slugs are NOT
-- rewritten back: a slug recomputed here stays until a migration recomputes it
-- again. Reversing REOPENS §66.11's gap and §74's. TrailService.listTrails then
-- answers a destination filter with 503 (trails_unavailable), never a string match.
