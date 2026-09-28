-- 3441_trail_letter_fold_decompose_first.sql
-- census-discovery §73 (lane P27): DV-20, the Trail letter fold decomposes
-- FIRST and carries the whole stroke/hook/bar table. Replaces 3415's
-- trail_letter_fold; trail_canonical_slug and trail_normalised_destination call
-- it and are unchanged.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it: NOT portava-ci, NOT production (3415 is
-- in neither). Rehearsed on the local PostgreSQL 16 harness only, if
-- census-discovery §73 says so. It reads no table and writes nothing.
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
END
$post$;

COMMIT;

-- REVERSAL: re-run 3415's CREATE OR REPLACE FUNCTION public.trail_letter_fold
-- (translate of the raw text, fourteen letters). Reversing REOPENS §66.11's gap.
