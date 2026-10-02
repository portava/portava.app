-- Rollback for 3421_ranking_debug_samples_content_id_nullable.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3421 DID
-- =============
--   * ALTER TABLE public.ranking_debug_samples ALTER COLUMN content_id DROP NOT NULL;
--   * COMMENT ON COLUMN content_id (it had none in the baseline).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
--   * DELETES every sample whose content_id is NULL. These are debugging rows
--     (7-day retention, purge_old_ranking_debug_samples()), written since 3421
--     for items with no uuid id — every Discovery place. The restored NOT NULL
--     would refuse them, so they cannot be kept; the count is reported.
--   * Restores content_id NOT NULL and removes 3421's column comment.
--   * Deletes 3421's schema_migration_ledger row.
--
-- ⚠ IT RE-OPENS THE DEFECT 3421 CLOSED: every Discovery debug sample is refused
-- 23502 again (DiscoveryRankingService now logs each refusal instead of
-- discarding it, so the re-opening is loud). Samples with a uuid item id keep
-- landing, because the writer supplies content_type and content_id for them.

BEGIN;

DO $$
DECLARE
  id_null text;
  n       bigint;
BEGIN
  IF to_regclass('public.ranking_debug_samples') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421 rollback): public.ranking_debug_samples does not exist.';
  END IF;
  SELECT is_nullable INTO id_null FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_id';
  IF id_null IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3421 rollback): content_id is not nullable; this is not the state 3421 left.';
  END IF;
  SELECT count(*) INTO n FROM public.ranking_debug_samples WHERE content_id IS NULL;
  RAISE NOTICE '3421 rollback: deleting % debug sample(s) with no content_id.', n;
END $$;

DELETE FROM public.ranking_debug_samples WHERE content_id IS NULL;

ALTER TABLE public.ranking_debug_samples ALTER COLUMN content_id SET NOT NULL;

COMMENT ON COLUMN public.ranking_debug_samples.content_id IS NULL;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3421_ranking_debug_samples_content_id_nullable.sql';

COMMIT;

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ranking_debug_samples' AND column_name = 'content_id') <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421 rollback): content_id is not NOT NULL again.';
  END IF;
  IF col_description('public.ranking_debug_samples'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.ranking_debug_samples'::regclass AND attname = 'content_id')) IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421 rollback): 3421''s column comment is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3421_ranking_debug_samples_content_id_nullable.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3421 rollback): the ledger still records 3421 as applied.';
  END IF;
END $post$;
