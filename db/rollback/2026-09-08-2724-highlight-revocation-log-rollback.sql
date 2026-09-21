-- Rollback for 2724_highlight_revocation_log.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908152035. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- Rehearsed on CI in a rolled-back transaction alongside 2722: relations → 0,
-- policies → 0 (there were none — RLS with no policy is the deny-by-default
-- design), constraints → 0, FK targets survive, siblings survive.
--
-- ── DROPPING AN AUDIT LOG IS NOT LIKE DROPPING A CACHE ───────────────────────
--
-- Every other table in this family is rebuildable. This one is not: it records
-- what a revocation attempt REACHED, including the destinations it could not
-- reach. Its whole value is that `not_implemented` and `not_applicable` are
-- first-class — a destination that was not reached is recorded as not reached
-- rather than omitted. Dropping it does not lose derived state; it loses the
-- evidence that a deletion happened at all, and the only remaining answer to
-- "did the deletion reach the search index" becomes silence.
--
-- Export before rolling back, or roll back only while the table is empty.

BEGIN;

DROP TABLE IF EXISTS public.highlight_revocation_log;

DO $$
DECLARE leftover INTEGER;
BEGIN
  SELECT count(*) INTO leftover FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'highlight\_revocation%';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2724 survive', leftover;
  END IF;

  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.profiles is gone -- 2724 referenced it via actor_id, it did not create it';
  END IF;

  IF to_regclass('public.highlight_sources') IS NULL
     OR to_regclass('public.highlight_resurfacing_preferences') IS NULL
     OR to_regclass('public.highlight_projection_policies') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a sibling highlight_* table was dropped -- this inverse is for 2724 alone';
  END IF;
END $$;

COMMIT;
