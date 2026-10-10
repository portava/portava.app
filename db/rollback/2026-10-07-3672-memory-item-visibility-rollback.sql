-- Rollback for 3672_memory_item_visibility.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3672 DID: added memory_items.visibility (NULL = inherit, 'only_me') with
-- its CHECK, and re-created memory_items_public_read so an only_me photo is not
-- publicly readable.
-- WHAT THIS ROLLBACK DOES: refuses while any photo is 'only_me' — dropping the
-- column would make a photo its owner kept private readable by everyone who can
-- see the Memory. With none set, it restores the 0067 policy verbatim and drops
-- the column and its CHECK.

BEGIN;

-- The column check and the row check are two statements, not one expression:
-- PL/pgSQL plans a statement when it first runs it, so the row check is never
-- planned on a database without the column (VERIFY-H4 H4-5). Run again after a
-- rollback, this file is then a no-op that re-creates the 0067 policy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility') THEN
    IF EXISTS (SELECT 1 FROM public.memory_items WHERE visibility IS NOT NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3672): some photos are kept private (only_me). Rolling back would expose them.';
    END IF;
  END IF;
END $$;

DROP POLICY IF EXISTS memory_items_public_read ON public.memory_items;
CREATE POLICY memory_items_public_read ON public.memory_items FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.memories m
    WHERE m.id = memory_items.memory_id
      AND m.state = 'published'
      AND m.visibility = 'public'
  )
);
ALTER TABLE public.memory_items DROP CONSTRAINT IF EXISTS memory_items_visibility_check;
ALTER TABLE public.memory_items DROP COLUMN IF EXISTS visibility;
DELETE FROM public.schema_migration_ledger WHERE filename = '3672_memory_item_visibility.sql';

COMMIT;

DO $post$
DECLARE qual text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672 rollback): memory_items.visibility still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_visibility_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672 rollback): memory_items_visibility_check still exists';
  END IF;
  SELECT pg_get_expr(polqual, polrelid) INTO qual FROM pg_policy
   WHERE polrelid = 'public.memory_items'::regclass AND polname = 'memory_items_public_read';
  IF qual IS NULL OR position('visibility IS NULL' in qual) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672 rollback): memory_items_public_read is not the 0067 policy (qual: %)', qual;
  END IF;
END $post$;
