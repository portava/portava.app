-- Rollback for 2723_highlight_class_lifecycle_and_pin.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908152414. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- ── THIS ONE IS DIFFERENT FROM ITS FOUR SIBLINGS ─────────────────────────────
--
-- 2720/2721/2722/2724 each create a table nothing else references; their
-- inverse is a DROP TABLE and the only question is whether it takes everything.
-- 2723 ALTERS `public.highlights` — the live, hot, policy-bearing table the
-- whole surface reads. So the questions are the opposite ones: does the inverse
-- take BACK everything 2723 added, and does it leave everything it did not add?
--
-- Rehearsed on CI in a rolled-back transaction: 22 columns back to 17, the five
-- added columns gone, BOTH CHECK constraints gone with them (a constraint whose
-- column no longer exists is exactly the residue this rehearsal is for), the
-- partial index gone, the 5 RLS policies UNCHANGED, and the 7 other
-- `highlights_*` indexes untouched.
--
-- ── SAFE ONLY WHILE NOTHING WRITES THESE COLUMNS ─────────────────────────────
--
-- Nothing does today: routes/highlights.ts POST lists its inserted columns
-- explicitly and does not use SELECT *, so it simply never names them, and
-- nothing backfilled them. Measured at rehearsal: 0 rows on CI, 0 highlights in
-- production. Once anything writes a lifetime_class, a lifecycle_state or a pin,
-- this DROP discards it silently — a dropped column raises nothing.

BEGIN;

DROP INDEX IF EXISTS public.highlights_pinned_idx;

ALTER TABLE public.highlights
  DROP COLUMN IF EXISTS lifetime_class,
  DROP COLUMN IF EXISTS lifecycle_state,
  DROP COLUMN IF EXISTS highlight_type,
  DROP COLUMN IF EXISTS pinned_at,
  DROP COLUMN IF EXISTS renderer_version;

DO $$
DECLARE added_cols INTEGER; leftover_checks INTEGER; leftover_index INTEGER;
        policies INTEGER; core_cols INTEGER;
BEGIN
  SELECT count(*) INTO added_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'highlights'
     AND column_name IN ('lifetime_class','lifecycle_state','highlight_type','pinned_at','renderer_version');
  IF added_cols <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % of 2723''s columns survive', added_cols;
  END IF;

  SELECT count(*) INTO leftover_checks FROM pg_constraint
   WHERE conrelid = 'public.highlights'::regclass
     AND conname IN ('highlights_lifetime_class_check','highlights_lifecycle_state_check');
  IF leftover_checks <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % CHECK constraint(s) from 2723 survive their columns', leftover_checks;
  END IF;

  SELECT count(*) INTO leftover_index FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'highlights_pinned_idx';
  IF leftover_index <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: highlights_pinned_idx survives';
  END IF;

  -- The half that matters more: what this inverse must NOT have taken.
  SELECT count(*) INTO core_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'highlights'
     AND column_name IN ('id','owner_id','media_url','media_type','visibility','expires_at','deleted_at','filter_id','filter_intensity');
  IF core_cols <> 9 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: only % of the 9 pre-2723 columns this file names are still present -- the inverse removed something it did not add', core_cols;
  END IF;

  SELECT count(*) INTO policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'highlights';
  IF policies <> 5 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.highlights has % RLS policies, expected the 5 that predate 2723 -- this migration adds none and its inverse must remove none', policies;
  END IF;
END $$;

COMMIT;
