-- 3421_ranking_debug_samples_content_id_nullable.sql
-- A ranking debug sample may name an item that has no uuid (census-discovery
-- §62, DV-52; `05` §9 "explainable enough for debugging").
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── THE DEFECT (census-discovery §59.1 DV-52, pinned by
--    src/test/db/discoveryVerifyExplain.db.test.ts X1/X5) ─────────────────────
-- Production's ranking_debug_samples (baseline 20260819) carries
-- `content_type text NOT NULL` and `content_id uuid NOT NULL`, from the table's
-- first definition (supabase/migrations/20260801_ranking_discovery_foundation.sql).
-- 2060 added the columns DiscoveryRankingService's sampler actually writes
-- (item_id text, session_id, components, explanation_key) and never reconciled
-- those two. The sampler omitted both, so EVERY sample on every surface was
-- refused 23502 — and the refusal was discarded.
--
-- ── WHAT THIS DOES, AND WHAT THE WRITER NOW DOES ────────────────────────────
-- ONE statement: ALTER COLUMN content_id DROP NOT NULL. Nothing else changes —
-- no row, no index, no grant, no policy, and content_type stays NOT NULL.
--   * The writer now supplies content_type on every sample (every ranked item
--     has a type) and content_id when the item id IS a uuid (a post, an event).
--   * A Discovery item id is `node/123` or `db/<uuid>`, and the `db/` uuid names
--     either a discovery_places row or a public.places row (lib/placeIdBridge.ts),
--     so the writer cannot truthfully put it in a column that does not say which
--     table it names, and must not mint one. Its identity is `item_id`, which
--     every sample carries. content_id is NULL for such a sample, and that is
--     what this migration permits.
--
-- ── WHO READS THE COLUMN (census-discovery §62.3) ───────────────────────────
-- GET /admin/ranking/debug-samples (routes/adminRankingConfig.ts) selects `*`
-- and filters on surface, content_type and ranking_version — never content_id;
-- a NULL is returned as null. purge_old_ranking_debug_samples() deletes by
-- sampled_at. No view, materialized view or other function reads the table, and
-- no client does. So every reader tolerates NULL.
--
-- ── `10` §4 ─────────────────────────────────────────────────────────────────
-- No query path, index or table is added. DROP NOT NULL is a catalogue change:
-- no scan, no rewrite; it takes ACCESS EXCLUSIVE for the instant of the change.
--
-- Rollback: db/rollback/2026-09-27-3421-ranking-debug-samples-content-id-nullable-rollback.sql
-- (deletes the samples that have no content_id — 7-day debugging rows the
-- restored constraint would refuse — then restores NOT NULL and deletes this
-- file's ledger row).

BEGIN;

DO $$
DECLARE
  rel      regclass := to_regclass('public.ranking_debug_samples');
  id_type  text;
  id_null  text;
  ty_null  text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421): public.ranking_debug_samples does not exist.';
  END IF;
  SELECT data_type, is_nullable INTO id_type, id_null FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_id';
  SELECT is_nullable INTO ty_null FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_type';
  IF id_type IS NULL OR ty_null IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421): ranking_debug_samples lacks content_id or content_type; this is not the baseline structure 3421 was written against.';
  END IF;
  IF id_type <> 'uuid' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421): ranking_debug_samples.content_id is %, not uuid; resolve by hand.', id_type;
  END IF;
  IF id_null = 'YES' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421): ranking_debug_samples.content_id is already nullable; 3421 is applied, or someone relaxed it by hand.';
  END IF;
  -- The writer's three reads-by-name: item_id, components, explanation_key (2060).
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples'
         AND column_name IN ('item_id', 'session_id', 'components', 'explanation_key')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421): 2060''s sampler columns are not all present. Apply 2060_ranking_debug_samples.sql first.';
  END IF;
END $$;

ALTER TABLE public.ranking_debug_samples ALTER COLUMN content_id DROP NOT NULL;

COMMENT ON COLUMN public.ranking_debug_samples.content_id IS
  '3421 / census-discovery DV-52. The item''s uuid when its id IS a uuid (a post, '
  'an event); NULL for an item with no uuid id — a Discovery place (`node/…`, '
  '`db/<uuid>` whose table the id does not state). item_id carries every item''s '
  'identity. Written by services/ranking/DiscoveryRankingService.ts sampleContentId.';

-- ── Behavioural postcondition, INSIDE the applying transaction ─────────────
-- It writes (a probe rolled back by its own exception block), so it runs
-- before COMMIT.
DO $probe$
BEGIN
  BEGIN
    INSERT INTO public.ranking_debug_samples (viewer_id, content_type, content_id, final_score, surface, item_id, components, explanation_key)
    VALUES (NULL, 'place', NULL, 1, '3421-probe', 'node/3421', '{}'::jsonb, '3421-probe');
    RAISE EXCEPTION USING ERRCODE = 'P3421', MESSAGE = '3421 probe landed';
  EXCEPTION
    WHEN SQLSTATE 'P3421' THEN NULL;   -- landed; rolled back with the subtransaction
    WHEN not_null_violation THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3421): a sample with no content_id is still refused: %', SQLERRM;
  END;
  -- And content_type is still required: a sample with no type is refused.
  BEGIN
    INSERT INTO public.ranking_debug_samples (viewer_id, content_type, content_id, final_score, surface, item_id)
    VALUES (NULL, NULL, NULL, 1, '3421-probe', 'node/3421');
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421): a sample with no content_type was accepted.';
  EXCEPTION
    WHEN not_null_violation THEN NULL;
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate: they assert what persisted) ──────────────────
DO $post$
DECLARE
  id_null text;
  ty_null text;
  n       int;
BEGIN
  SELECT is_nullable INTO id_null FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_id';
  SELECT is_nullable INTO ty_null FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_type';
  IF id_null <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421): content_id is still NOT NULL.';
  END IF;
  IF ty_null <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421): content_type lost its NOT NULL; 3421 relaxes content_id only.';
  END IF;
  SELECT count(*) INTO n FROM public.ranking_debug_samples WHERE surface = '3421-probe';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421): % probe row(s) persisted.', n;
  END IF;
END $post$;
