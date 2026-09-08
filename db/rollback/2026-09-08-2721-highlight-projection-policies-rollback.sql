-- Rollback for 2721_highlight_projection_policies.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908151706. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- ── WHY THIS ROLLBACK IS SAFE IN A WAY MOST ARE NOT ──────────────────────────
--
-- services/highlights/highlightProjectionPolicy.ts distinguishes three states,
-- and the two that matter here are NOT the same:
--
--   absent      "highlight_projection_policies is not deployed (migration 2721
--               not applied); §10 location precision is UNENFORCED on this
--               surface" -- reports, does NOT clamp
--   unreadable  clamps to HIDDEN
--
-- So dropping the table returns the surface to UNENFORCED, not to suppressed.
-- Verified before applying, by reading routes/highlights.ts rather than assuming
-- it: the route consumes `resolveLocationDisclosure` only, and both the `absent`
-- branch and the `present, no row` branch return the location UNCHANGED. The
-- consent side (`consentFromRow`, where unknown REFUSES) has no route caller
-- today, so applying 2721 over an empty table could not suppress anything, and
-- dropping it cannot either.
--
-- ── WHAT THE DROP DESTROYS ───────────────────────────────────────────────────
--
-- Every row is an owner's §10 choice: a location rung, a person-visibility rung
-- and five consent dimensions. Dropping the table does not fail closed for
-- LOCATION -- it makes precise locations publishable again on any surface that
-- consults this. Roll back only while the table is empty, or after exporting it.

BEGIN;

DROP TABLE IF EXISTS public.highlight_projection_policies;

DO $$
DECLARE leftover_relations INTEGER; leftover_policies INTEGER; highlights_cols INTEGER;
BEGIN
  SELECT count(*) INTO leftover_relations
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'highlight\_projection\_policies%';
  IF leftover_relations <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2721 survive', leftover_relations;
  END IF;

  SELECT count(*) INTO leftover_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'highlight_projection_policies';
  IF leftover_policies <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % RLS policy row(s) survive', leftover_policies;
  END IF;

  -- Both FK targets must survive. 2721 references highlights and profiles; it
  -- created neither, and a rehearsal that counted only the table it meant to
  -- remove would not have noticed either going with it.
  IF to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.highlights is gone';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.profiles is gone';
  END IF;

  SELECT count(*) INTO highlights_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'highlights';
  IF highlights_cols <> 17 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.highlights has % columns, expected the 17 it had before and after 2721 -- the forward migration deliberately does NOT add audience_policy_id to it', highlights_cols;
  END IF;
END $$;

COMMIT;
