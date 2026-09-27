-- 3415_trail_proposal_serialised.sql
-- Discovery Trails (census-discovery DC-03, §61): `02_Trails.md` §5's four
-- canonicalization checks decide Trail creation under CONCURRENT proposers, not
-- only under sequential ones.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- Eight functions. The first six carry lib/discoveryTrailObject.ts's §5 rules
-- (and lib/discoveryTrailFold.ts's letter fold) into SQL verbatim; they read no
-- table and write nothing:
--   trail_letter_fold(text)                    trailLetterFold (§61, DV-20)
--   trail_canonical_slug(text)                 canonicalTrailSlug
--   trail_title_tokens(text)                   titleTokens (a sorted, distinct set)
--   trail_normalised_destination(text)         normDestination
--   trail_token_similarity(text[], text[])     jaccard, rounded as Math.round does
--   trail_canonicalisation_verdict(text, text, jsonb)
--                                              canonicaliseTrailProposal over the
--                                              peers it is handed, in their order
-- Then:
--   trail_proposal_peers(text, text)           the comparison set proposeTrail
--                                              reads: the proposal's destination,
--                                              every destination-less Trail, and
--                                              every slug containing one of the
--                                              pigeonhole tokens — the SAME filter
--   trail_propose(text, text, text, uuid, uuid)
--                                              lock → parent → peers → verdict →
--                                              the declared parent's waiver →
--                                              INSERT, in one transaction
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- TrailService.proposeTrail read the catalogue, ran the four checks in
-- TypeScript and then inserted. Two proposals racing each other each checked a
-- catalogue that did not yet hold the other, so "Bangkok After Dark" and "After
-- Dark Bangkok" (different slugs) could both be admitted; the UNIQUE slug
-- refuses only an identical one (census-discovery §51.6, DC-03). The TypeScript
-- checks stay as the fast pre-check and still produce the answer on the
-- non-racing path; this function is the decision that is taken where the insert
-- is, under a lock, and it can only refuse more.
--
-- THE LOCK IS PER TITLE TOKEN, and that is sufficient, not a heuristic. Each of
-- the four refusals implies the two titles share at least one token:
--   CHECK 1  similarity >= 0.8, or an identical slug          → shared tokens > 0
--   CHECK 2  similarity >= 0.6                                 → shared tokens > 0
--   CHECK 3  theme similarity >= 0.5 (theme ⊆ title tokens)    → shared tokens > 0
--   CHECK 4  a non-empty strict token subset of the proposal   → shared tokens > 0
-- So two proposals that could refuse each other both lock that shared token and
-- are serialised; two that share no token cannot collide and never wait on each
-- other. Locks are taken in ascending key order, so two proposals sharing
-- several tokens cannot deadlock. Under READ COMMITTED the peer read after the
-- lock takes a fresh snapshot and sees the committed racer; under a transaction
-- snapshot it would not, so trail_propose REFUSES to run at any other isolation
-- level rather than admit without the guarantee.
--
-- THE SQL MIRRORS TYPESCRIPT, AND THE DRIFT HAZARD THAT CREATES (the same
-- arrangement 2892 documents for momentum). src/test/discoveryTrailIntegrity.test.ts
-- pins this file's three thresholds and its similarity rounding to the
-- TypeScript constants, and src/test/db/trailsProposalRace.db.test.ts runs both
-- over the same inputs and requires the same verdicts. Letter case is lowered
-- for ASCII only, and that is exact: after the stroke fold and the Unicode
-- decomposition every letter whose lowercase is ASCII IS ASCII, and every other
-- non-ASCII character becomes a separator either way. Two places where the SQL
-- deliberately sees MORE than the pre-check, and so can only refuse more:
--   * the peer read has no LIMIT; proposeTrail's reads at most 1000 rows and
--     logs when it reached that bound. Past 1000 peers SQL sees more.
--   * the peer read also matches a destination by its search KEY (§61, DV-20):
--     "da nang" beside "Đà Nẵng". PostgREST cannot compute that key, so the
--     pre-check reads only the exact spelling plus the title-token legs.
--
-- ── `10` §6 — SECURITY ──────────────────────────────────────────────────────
-- Every function is SECURITY INVOKER with a pinned search_path. None needs
-- definer rights: the one caller is the API's service client (service_role),
-- which already holds INSERT on trails; a client role must not be able to call
-- trail_propose at all, because it takes `p_created_by` as an argument. EXECUTE
-- is revoked from PUBLIC, anon and authenticated on all eight.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
-- Apply BEFORE deploying the TrailService that calls trail_propose. That code
-- fails CLOSED without it: POST /v1/discovery/trails answers 503
-- degraded_unavailable rather than creating a Trail unserialised.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- Production holds 0 Trails (2910 applied 2026-09-20, empty). The peer read is
-- proposeTrail's existing read moved under the lock (docs/discovery/query-paths.md
-- QP-25): `destination = $1` uses idx_trails_destination_lifecycle, and the
-- `slug ILIKE '%tok%'` legs cannot use a b-tree, so the read is a sequential scan
-- of `trails` at any size — at the harness's 2,000 synthetic Trails, well under a
-- millisecond. Nothing is indexed here.
--
-- Rollback: db/rollback/2026-09-27-3415-trail-proposal-serialised-rollback.sql
-- (drops the eight functions; deletes no row; creation then answers 503 until
-- this file is re-applied).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3415): public.trails does not exist. Apply 2910_discovery_trails.sql first.';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3415): normalize(text, NFKD) needs a UTF8 database; this one is %.', current_setting('server_encoding');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trails' AND column_name = 'canonicalization') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3415): public.trails has no canonicalization column; this is not 2910''s table.';
  END IF;
END
$pre$;

-- ── lib/discoveryTrailFold.trailLetterFold ──────────────────────────────────
-- census-discovery §61 (DV-20). A Latin letter with no Unicode decomposition is
-- DELETED by the slug's [^a-z0-9] step unless it is folded first:
--   the STROKE fold — lib/canonicalLocations' STROKE_FOLD, the same fourteen
--     letters 2220's input_normalize_city_key translates, one letter each;
--   the LETTER fold — TRAIL_LETTER_FOLD, the CLDR Latin-ASCII spelling of the
--     letters with neither decomposition nor stroke: ß ẞ → ss, æ Æ → ae,
--     œ Œ → oe, þ Þ → th, ŋ Ŋ → ng.
-- Both tables are pinned to the TypeScript by src/test/discoveryTrailIntegrity.test.ts.
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

-- ── canonicalTrailSlug ──────────────────────────────────────────────────────
-- letter fold (trail_letter_fold) → NFKD → strip U+0300–U+036F → lowercase → runs of [^a-z0-9]
-- become '-' → trim '-' → NULL when empty. The two character classes are
-- spelled out, not given as ranges, so no collation can change them.
--
-- THE LETTER FOLD (census-discovery §61, DV-20; trail_letter_fold above). A
-- stroke through a letter is part of the base codepoint, so NFKD leaves it and
-- the [^a-z0-9] step then DELETED the letter: "Đà Nẵng street food" slugged to `a-nang-street-food` beside
-- "Da Nang street food"'s `da-nang-street-food`, and both were admitted.
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

-- ── titleTokens: the slug's words, as a set ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.trail_title_tokens(p_title text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
  SELECT coalesce(array_agg(DISTINCT t COLLATE "C" ORDER BY t COLLATE "C"), ARRAY[]::text[])
    FROM unnest(string_to_array(public.trail_canonical_slug(p_title), '-')) AS t
$fn$;

-- ── normDestination: lib/canonicalLocations.searchKey; '' → NULL ────────────
-- census-discovery §61 (DV-20): two destinations are ONE destination when their
-- geographic search key is equal — the fold B01 and 2220 already use, so
-- "Đà Nẵng", "DA NANG" and "da nang" compare equal. trailDestinationKey is the
-- letter fold (trail_letter_fold), then searchKey: stroke fold →
-- NFD → strip U+0300–U+036F → lowercase → every run of non-[a-z0-9] becomes one
-- space → trim → drop a leading "city|municipality|province|district|town of"
-- and a trailing "city|municipality|metro", unless that leaves nothing.
-- (JavaScript's two steps — `[^a-z0-9\s]` → ' ', then `\s+` → ' ' — are exactly
-- one step here: every non-[a-z0-9] character is either whitespace or becomes a
-- space, and each run then collapses to one.) Lowercasing is ASCII-only, which
-- is exact: after the stroke fold and NFD every letter whose lowercase is ASCII
-- is already ASCII, and anything else becomes a space either way.
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

-- ── jaccard ─────────────────────────────────────────────────────────────────
-- Math.round(shared / union * 1000) / 1000, in IEEE doubles as JavaScript
-- computes it, and rounded half UP as Math.round does (PostgreSQL's round() on
-- a double rounds half to even, which is why it is not used). `x - floor(x)` is
-- exact for these magnitudes, so the comparison with 0.5 is too.
CREATE OR REPLACE FUNCTION public.trail_token_similarity(p_a text[], p_b text[])
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  na int := (SELECT count(DISTINCT t) FROM unnest(coalesce(p_a, ARRAY[]::text[])) AS t);
  nb int := (SELECT count(DISTINCT t) FROM unnest(coalesce(p_b, ARRAY[]::text[])) AS t);
  shared int;
  uni int;
  x double precision;
  r double precision;
BEGIN
  IF na = 0 OR nb = 0 THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO shared FROM (SELECT unnest(p_a) INTERSECT SELECT unnest(p_b)) AS s;
  uni := na + nb - shared;
  IF uni = 0 THEN
    RETURN 0;
  END IF;
  x := (shared::double precision / uni::double precision) * 1000::double precision;
  r := floor(x);
  IF x - r >= 0.5::double precision THEN
    r := r + 1;
  END IF;
  RETURN r / 1000::double precision;
END;
$fn$;

-- ── canonicaliseTrailProposal ───────────────────────────────────────────────
-- Over the peers it is handed, in their order, exactly as the TypeScript
-- iterates them: all four checks run and all four report; CHECK 1 is
-- destination-independent; checks 2–4 need the same (normalised) destination;
-- CHECK 3 compares THEME tokens (the destination's words removed); CHECK 4's
-- first strict-superset peer is the suggested parent. Thresholds 0.8 / 0.6 / 0.5
-- are DUPLICATE_TITLE_SIMILARITY / DESTINATION_OVERLAP_SIMILARITY /
-- SEMANTIC_OVERLAP_SIMILARITY.
CREATE OR REPLACE FUNCTION public.trail_canonicalisation_verdict(p_title text, p_destination text, p_peers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  c_duplicate   CONSTANT double precision := 0.8;
  c_destination CONSTANT double precision := 0.6;
  c_semantic    CONSTANT double precision := 0.5;
  v_slug  text := public.trail_canonical_slug(p_title);
  v_dest  text := public.trail_normalised_destination(p_destination);
  v_mine  text[];
  v_theme text[];
  v_dest_tokens text[];
  v_theirs text[];
  v_their_theme text[];
  v_sim double precision;
  v_theme_sim double precision;
  v_same boolean;
  v_id text;
  peer jsonb;
  v_refusals jsonb := '[]'::jsonb;
  v_parent text := NULL;
BEGIN
  IF v_slug IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'slug', NULL,
      'refusals', jsonb_build_array(jsonb_build_object('check', 'uncanonicalisable_title', 'conflictsWith', NULL, 'similarity', 0)),
      'suggestedParentTrailId', NULL);
  END IF;

  v_mine := public.trail_title_tokens(p_title);
  v_dest_tokens := public.trail_title_tokens(v_dest);
  v_theme := ARRAY(SELECT t FROM unnest(v_mine) AS t WHERE NOT (t = ANY (v_dest_tokens)));

  FOR peer IN SELECT e.value FROM jsonb_array_elements(coalesce(p_peers, '[]'::jsonb)) AS e LOOP
    CONTINUE WHEN jsonb_typeof(peer) IS DISTINCT FROM 'object' OR jsonb_typeof(peer -> 'id') IS DISTINCT FROM 'string';
    v_id := peer ->> 'id';
    v_theirs := CASE WHEN jsonb_typeof(peer -> 'title') = 'string'
                     THEN public.trail_title_tokens(peer ->> 'title') ELSE ARRAY[]::text[] END;
    v_sim := public.trail_token_similarity(v_mine, v_theirs);
    v_same := v_dest IS NOT NULL
              AND jsonb_typeof(peer -> 'destination') = 'string'
              AND public.trail_normalised_destination(peer ->> 'destination') = v_dest;

    -- CHECK 1 — duplicate title similarity, destination-independent.
    IF v_sim >= c_duplicate OR (jsonb_typeof(peer -> 'slug') = 'string' AND v_slug = peer ->> 'slug') THEN
      v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
        'check', 'duplicate_title_similarity', 'conflictsWith', v_id, 'similarity', v_sim));
    END IF;

    IF v_same THEN
      -- CHECK 2 — destination overlap.
      IF v_sim >= c_destination THEN
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
          'check', 'destination_overlap', 'conflictsWith', v_id, 'similarity', v_sim));
      END IF;
      -- CHECK 3 — semantic overlap, on THEME tokens.
      v_their_theme := ARRAY(SELECT t FROM unnest(v_theirs) AS t WHERE NOT (t = ANY (v_dest_tokens)));
      v_theme_sim := public.trail_token_similarity(v_theme, v_their_theme);
      IF v_theme_sim >= c_semantic THEN
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
          'check', 'semantic_overlap', 'conflictsWith', v_id, 'similarity', v_theme_sim));
      END IF;
      -- CHECK 4 — existing parent/child: a strict token superset of a live peer.
      IF cardinality(v_theirs) > 0 AND cardinality(v_theirs) < cardinality(v_mine) AND v_theirs <@ v_mine THEN
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
          'check', 'existing_parent_child', 'conflictsWith', v_id, 'similarity', v_sim));
        IF v_parent IS NULL THEN
          v_parent := v_id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_refusals) = 0, 'slug', v_slug,
    'refusals', v_refusals, 'suggestedParentTrailId', v_parent);
END;
$fn$;

-- ── proposeTrail's comparison set ───────────────────────────────────────────
-- The PostgREST filter TrailService.proposeTrail sends, in SQL:
--   destination.eq.<destination> (when the destination is non-empty),
--   [the database's own leg: the same destination by search key, §61 DV-20]
--   destination.is.null,
--   slug.ilike.*<tok>* for the first `needed` tokens, longest first then
--   ascending, where needed = |T| − ceil(0.8·|T|) + 1 (computed in doubles, as
--   JavaScript does).
-- Ordered oldest first, which is the order CHECK 4's suggested parent follows.
CREATE OR REPLACE FUNCTION public.trail_proposal_peers(p_title text, p_destination text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_tokens text[];
  v_needed int;
  v_patterns text[];
  v_key text := public.trail_normalised_destination(p_destination);
BEGIN
  SELECT coalesce(array_agg(t ORDER BY length(t) DESC, t COLLATE "C"), ARRAY[]::text[])
    INTO v_tokens
    FROM unnest(public.trail_title_tokens(p_title)) AS t;
  v_needed := cardinality(v_tokens)
              - ceil(0.8::double precision * cardinality(v_tokens)::double precision)::int + 1;
  v_patterns := ARRAY(SELECT '%' || t || '%' FROM unnest(v_tokens[1:greatest(0, v_needed)]) AS t);

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', tr.id, 'slug', tr.slug, 'title', tr.title, 'destination', tr.destination)
             ORDER BY tr.created_at, tr.id), '[]'::jsonb)
      FROM public.trails AS tr
     WHERE (p_destination IS NOT NULL AND p_destination <> '' AND tr.destination = p_destination)
        -- §61 (DV-20): the same destination under another spelling. The
        -- pre-check's PostgREST read cannot compute a key, so this leg is the
        -- database's alone: a racer or peer filed as "da nang" beside "Đà Nẵng"
        -- is compared here even when the pre-check did not read it.
        OR (v_key IS NOT NULL AND public.trail_normalised_destination(tr.destination) = v_key)
        OR tr.destination IS NULL
        OR tr.slug ILIKE ANY (v_patterns));
END;
$fn$;

-- ── The decision, where the insert is ───────────────────────────────────────
-- Arguments are what proposeTrail inserted before: the title trimmed, the
-- destination trimmed and lowercased (JavaScript), the description, the declared
-- parent, the proposer. Returns one of:
--   {"outcome":"created","trail":{…TRAIL_COLUMNS…}}
--   {"outcome":"refused","refusals":[…],"suggestedParentTrailId":…}
--   {"outcome":"invalid_parent"}
-- A UNIQUE slug collision with a Trail some other path inserted still raises
-- 23505, which proposeTrail reports as CHECK 1 exactly as it did before.
CREATE OR REPLACE FUNCTION public.trail_propose(
  p_title text, p_destination text, p_description text, p_parent_trail_id uuid, p_created_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_key bigint;
  v_parent_state text;
  v_peers jsonb;
  v_verdict jsonb;
  v_refusals jsonb;
  v_row public.trails%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'trail_propose requires READ COMMITTED (this transaction is %): under a transaction snapshot the per-token lock cannot show it a racing proposal', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- 1. Serialise against every proposal this one could collide with.
  FOR v_key IN
    SELECT DISTINCT hashtextextended('trail_propose:token:' || t, 0) AS k
      FROM unnest(public.trail_title_tokens(p_title)) AS t
     ORDER BY k
  LOOP
    PERFORM pg_advisory_xact_lock(v_key);
  END LOOP;

  -- 2. The declared parent, read by id and held against a concurrent archive.
  IF p_parent_trail_id IS NOT NULL THEN
    SELECT tr.lifecycle_status INTO v_parent_state
      FROM public.trails AS tr WHERE tr.id = p_parent_trail_id FOR SHARE;
    IF NOT FOUND OR v_parent_state = 'archived' THEN
      RETURN jsonb_build_object('outcome', 'invalid_parent');
    END IF;
  END IF;

  -- 3. The four checks, over the catalogue as it stands under the lock.
  v_peers := public.trail_proposal_peers(p_title, p_destination);
  v_verdict := public.trail_canonicalisation_verdict(p_title, p_destination, v_peers);

  -- 4. A declared parent waives the overlap refusals THAT PARENT raised, and
  --    nothing else (proposeTrail's WAIVED_BY_PARENT).
  SELECT coalesce(jsonb_agg(x.r ORDER BY x.ord), '[]'::jsonb) INTO v_refusals
    FROM jsonb_array_elements(v_verdict -> 'refusals') WITH ORDINALITY AS x(r, ord)
   WHERE NOT (p_parent_trail_id IS NOT NULL
              AND x.r ->> 'check' IN ('existing_parent_child', 'destination_overlap', 'semantic_overlap')
              AND x.r ->> 'conflictsWith' = p_parent_trail_id::text);
  IF jsonb_array_length(v_refusals) > 0 OR (v_verdict ->> 'slug') IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused', 'refusals', v_refusals,
      'suggestedParentTrailId', v_verdict -> 'suggestedParentTrailId');
  END IF;

  INSERT INTO public.trails (slug, title, description, destination, parent_trail_id, created_by, canonicalization, lifecycle_status)
  VALUES (
    v_verdict ->> 'slug', p_title, p_description, p_destination, p_parent_trail_id, p_created_by,
    jsonb_build_object(
      'checks', jsonb_build_array('duplicate_title_similarity', 'destination_overlap', 'semantic_overlap', 'existing_parent_child'),
      'comparedAgainst', jsonb_array_length(v_peers),
      'origin', CASE WHEN p_created_by IS NULL THEN 'system' ELSE 'user' END,
      'waivedByDeclaredParent', p_parent_trail_id,
      'decidedBy', 'trail_propose (3415), under the per-token lock'),
    'proposed')
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('outcome', 'created', 'trail', jsonb_build_object(
    'id', v_row.id, 'slug', v_row.slug, 'title', v_row.title, 'description', v_row.description,
    'destination', v_row.destination, 'place_scope', v_row.place_scope,
    'parent_trail_id', v_row.parent_trail_id, 'lifecycle_status', v_row.lifecycle_status,
    'created_by', v_row.created_by, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at));
END;
$fn$;

REVOKE ALL ON FUNCTION public.trail_letter_fold(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_canonical_slug(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_title_tokens(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_normalised_destination(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_token_similarity(text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_canonicalisation_verdict(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_proposal_peers(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trail_propose(text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_letter_fold(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_canonical_slug(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_title_tokens(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_normalised_destination(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_token_similarity(text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_canonicalisation_verdict(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_proposal_peers(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trail_propose(text, text, text, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.trail_propose(text, text, text, uuid, uuid) IS
  '3415 / 02_Trails.md §5 (census-discovery DC-03): Trail creation decided under a per-title-token advisory lock — the four canonicalization checks re-run over the catalogue as it stands, the declared parent re-read, then the INSERT, in one READ COMMITTED transaction. Mirrors lib/discoveryTrailObject.canonicaliseTrailProposal; TrailService.proposeTrail keeps the TypeScript checks as its pre-check.';
COMMENT ON FUNCTION public.trail_canonicalisation_verdict(text, text, jsonb) IS
  '3415: lib/discoveryTrailObject.canonicaliseTrailProposal in SQL, over the peers given, in their order. Thresholds 0.8 / 0.6 / 0.5 pinned to the TypeScript constants by src/test/discoveryTrailIntegrity.test.ts.';

-- ── Behavioural postcondition, inside the applying transaction ──────────────
-- The canonical slug on a hostile title; then a created probe, and its
-- re-ordered spelling under another destination refused as CHECK 1. The
-- sentinel exception rolls both probes back.
DO $probe$
DECLARE r jsonb; first_id text;
BEGIN
  IF public.trail_canonical_slug(E'  Café — Kyoto’s  NIGHTS!! ') <> 'cafe-kyoto-s-nights' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415): trail_canonical_slug gave %', public.trail_canonical_slug(E'  Café — Kyoto’s  NIGHTS!! ');
  END IF;
  -- §61 (DV-20): a stroke letter is folded, and two spellings of one place are one destination.
  IF public.trail_canonical_slug(E'Đà Nẵng street food') <> 'da-nang-street-food'
     OR public.trail_normalised_destination(E'Đà Nẵng') IS DISTINCT FROM 'da nang'
     OR public.trail_normalised_destination('  DA  NANG ') IS DISTINCT FROM 'da nang'
     OR public.trail_canonical_slug(E'Stra\u00dfe \u00c6sir') <> 'strasse-aesir' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415): the stroke fold is not applied (slug %, destination %)',
      public.trail_canonical_slug(E'Đà Nẵng street food'), public.trail_normalised_destination(E'Đà Nẵng');
  END IF;
  IF public.trail_token_similarity(ARRAY['a','b','c'], ARRAY['a','b','c','d','e','f','g','h']) <> 0.375::double precision THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415): similarity 3/8 is not 0.375';
  END IF;
  BEGIN
    r := public.trail_propose('Migration3415 Probe After Dark', 'migration-3415-probe-bangkok', NULL, NULL, NULL);
    IF r ->> 'outcome' <> 'created' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): the first probe was not created: %', r;
    END IF;
    first_id := r -> 'trail' ->> 'id';
    r := public.trail_propose('After Dark Probe Migration3415', 'migration-3415-probe-phuket', NULL, NULL, NULL);
    IF r ->> 'outcome' <> 'refused'
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'refusals') x
                       WHERE x ->> 'check' = 'duplicate_title_similarity' AND x ->> 'conflictsWith' = first_id) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): a re-ordered title under another destination was not refused as CHECK 1: %', r;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3415', MESSAGE = '3415 probe rollback';
  EXCEPTION
    WHEN SQLSTATE 'P3415' THEN
      NULL;  -- the probes are rolled back with this block
  END;
END
$probe$;

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.trail_letter_fold(text)',
    'public.trail_canonical_slug(text)', 'public.trail_title_tokens(text)',
    'public.trail_normalised_destination(text)', 'public.trail_token_similarity(text[],text[])',
    'public.trail_canonicalisation_verdict(text,text,jsonb)', 'public.trail_proposal_peers(text,text)',
    'public.trail_propose(text,text,text,uuid,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): % is absent.', f;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): % must be SECURITY INVOKER (10 §6).', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc, unnest(proconfig) c
                    WHERE oid = to_regprocedure(f) AND c LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): % has no pinned search_path (10 §6).', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415): a client role may execute %.', f;
    END IF;
  END LOOP;
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415): trail_propose does not take the per-token lock.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE destination LIKE 'migration-3415-probe-%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415): a probe Trail persisted.';
  END IF;
END
$post$;
