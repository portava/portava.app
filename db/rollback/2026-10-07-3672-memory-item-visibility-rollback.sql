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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility')
     AND EXISTS (SELECT 1 FROM public.memory_items WHERE visibility IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3672): some photos are kept private (only_me). Rolling back would expose them.';
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
