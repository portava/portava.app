-- Rollback for 3386_creator_attribution_recommendation_link.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3386 DID
-- =============
--   * ALTER TABLE public.creator_attributions ADD COLUMN recommendation_id text NULL
--     + CHECK ca_recommendation_id_shape + partial index ca_recommendation_idx.
--   * CREATE FUNCTION public.creator_attribution_recommendation_is_served() and
--     the BEFORE INSERT trigger ca_recommendation_is_served.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the trigger, the function, the index, the CHECK and the column, and
-- deletes 3386's schema_migration_ledger row.
--
-- ORDER: roll back 3387 FIRST. 3387's supersession trigger reads this column,
-- and this file refuses while 3387's trigger is present.
--
-- ⚠ IT REFUSES WHILE ANY ROW CARRIES A recommendation_id. Dropping the column
-- destroys the only link from those attributions to the exposure that led to
-- them (`08` §4). Set `rollback.force_drop_recommendation_link` to 'on' in the
-- same session to drop populated links deliberately.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ca_supersession_is_lawful' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3386): 3387 is still applied (ca_supersession_is_lawful reads recommendation_id). Roll back 3387 first.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_attributions' AND column_name = 'recommendation_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.creator_attributions WHERE recommendation_id IS NOT NULL' INTO n;
    IF n > 0 AND coalesce(current_setting('rollback.force_drop_recommendation_link', true), '') <> 'on' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3386): % attribution(s) carry a recommendation_id, the only link to their exposure. Set rollback.force_drop_recommendation_link = on to drop them deliberately.', n;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS ca_recommendation_is_served ON public.creator_attributions;
DROP FUNCTION IF EXISTS public.creator_attribution_recommendation_is_served();
DROP INDEX IF EXISTS public.ca_recommendation_idx;
ALTER TABLE public.creator_attributions DROP CONSTRAINT IF EXISTS ca_recommendation_id_shape;
ALTER TABLE public.creator_attributions DROP COLUMN IF EXISTS recommendation_id;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3386_creator_attribution_recommendation_link.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_attributions' AND column_name = 'recommendation_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3386 rollback): creator_attributions.recommendation_id still exists';
  END IF;
  IF to_regproc('public.creator_attribution_recommendation_is_served') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3386 rollback): the trigger function still exists';
  END IF;
END
$post$;
