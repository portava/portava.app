-- Rollback for 2722_highlight_sources.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908151954. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- Rehearsed on CI in a rolled-back transaction: relations → 0, policies → 0,
-- constraints → 0, `public.highlights` and `public.profiles` both survive, and
-- the two sibling tables applied earlier the same day (2720, 2721) are still
-- present. That last count is the one worth keeping: these DROPs are by name,
-- and a name-prefix mistake would take a sibling with it silently.
--
-- ── WHAT THE DROP DESTROYS, AND WHY IT IS WORSE THAN IT LOOKS ────────────────
--
-- Every row answers "which Highlights project this Memory". §21 revocation
-- needs that question answered BEFORE it can claim the profile-Highlight
-- destination was reached. Dropping this table does not make revocation fail
-- loudly — it makes revocation unable to find its targets, which a
-- highlight_revocation_log row would then record as `not_applicable`. A
-- destination that cannot be enumerated looks exactly like a destination that
-- was not in use.

BEGIN;

DROP TABLE IF EXISTS public.highlight_sources;

DO $$
DECLARE leftover INTEGER; leftover_policies INTEGER;
BEGIN
  SELECT count(*) INTO leftover FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'highlight\_sources%';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2722 survive', leftover;
  END IF;

  SELECT count(*) INTO leftover_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'highlight_sources';
  IF leftover_policies <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % policy row(s) survive', leftover_policies;
  END IF;

  IF to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.highlights is gone -- 2722 referenced it, it did not create it';
  END IF;

  -- The siblings are separately-certified migrations. This inverse must not
  -- reach them.
  IF to_regclass('public.highlight_resurfacing_preferences') IS NULL
     OR to_regclass('public.highlight_projection_policies') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a sibling highlight_* table was dropped -- this inverse is for 2722 alone';
  END IF;
END $$;

COMMIT;
