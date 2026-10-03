-- Rollback for 3514_layover_crew_location_grants.sql (spec §14 L4 / census-layover L124, L132, lane 3514).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- REHEARSED 2026-10-03 on PostgreSQL 16, and here is exactly what that covered.
-- The cycle apply / re-apply / rollback / rollback-again / re-apply ran clean,
-- every postcondition block passed, and the NOTICE printed the real counts from
-- seeded rows (2 recorded acts of consent, 1 of them unrevoked) rather than
-- placeholders. The second rollback run reports ABSENCE rather than a count of
-- zero, because a count of zero would tell an operator that no consent history
-- was lost, and this file cannot know that once the table is gone.
--
-- WHAT THE REHEARSAL DID NOT COVER, said plainly rather than left implied: it
-- ran on a scratch database carrying minimal stand-ins for `profiles`,
-- `layover_crews` and `layover_sessions`, not the full migration chain, so it
-- proves this file's own SQL, its postconditions and its idempotency — not how
-- it behaves against a database with the real parent tables and their data.
--
-- WHAT 3514 DID: created public.layover_crew_location_grants — RLS on, no
-- permissive policy, four RESTRICTIVE client-deny policies, service_role
-- grants, two CHECK constraints (positive window, revocation not before grant)
-- and layover_crew_location_grants_newest_idx. It added no coordinate column
-- anywhere and altered nothing that existed.
--
-- WHAT THIS ROLLBACK DOES: reports the row count first, then drops the four
-- policies, the index and the table, then 3514's ledger row. Dropping it
-- returns the precision ladder to the state 3514 found it in — an absent grant
-- store reads as `never_granted`, so `locationPrecisionFor` answers `none` and
-- `meeting_point` only, which is what every caller already got before 3514.
-- 2984's postcondition asserting the crew tables hold no coordinate is not
-- touched and stays standing.
--
-- WHY THE COUNT IS PRINTED, AND WHY THIS FILE DOES NOT DROP SILENTLY
-- ------------------------------------------------------------------
-- A GRANT ROW IS EVIDENCE OF A DECISION A TRAVELLER MADE ABOUT THEIR OWN
-- WHEREABOUTS: this person said yes to this crew, from this hour until that
-- one, and — where `revoked_at` is set — took it back at a named minute.
-- Nothing derives those rows; they exist only because somebody consented, and a
-- revoked row is the only record that the consent was ever given and
-- withdrawn, which is the distinction `evaluateCrewLocationShare` reports as
-- `user_revoked` rather than `never_granted`. A DROP destroys the whole
-- consent history and no sweep, projection or backup of this table rebuilds it.
--
-- So the count goes to the terminal BEFORE the drop — total, and how many are
-- still unrevoked — because an operator should not discover AFTERWARDS how much
-- consent history the rollback erased. `RAISE NOTICE` is 3466's shape in this
-- lane for exactly this reason (rows nothing derives), and it is what this file
-- follows.
--
-- IT DOES NOT REFUSE, AND THAT IS DELIBERATE. The neighbouring files refuse
-- only where running on would TAKE A DECISION somebody else owns — 3488 while a
-- suggestion is still pending (dropping it answers "no" for its owner), 3487
-- while its flag is TRUE, 3510 while the C-11 retention question is open.
-- Dropping this table answers nothing on a traveller's behalf: an absent store
-- grants nothing, so every live grant simply stops being honoured, which is the
-- same answer a revocation gives. Inventing a confirmation flag here would be a
-- mechanism no other file in this directory has, and a reversal nobody can run
-- under pressure is its own hazard. The count is the honest middle: the
-- operator is told, and is not stopped.
--
-- Run this only with the crew routes' grant path withdrawn, or `granting`
-- answers on a table that is gone.

BEGIN;

DO $$
DECLARE n_total bigint := 0; n_live bigint := 0;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NOT NULL THEN
    EXECUTE 'SELECT count(*), count(*) FILTER (WHERE revoked_at IS NULL) FROM public.layover_crew_location_grants'
      INTO n_total, n_live;
    RAISE NOTICE '3514 rollback: dropping public.layover_crew_location_grants with % recorded act(s) of consent, of which % unrevoked. Each row is a traveller''s own decision to share their live location; nothing derives them and nothing rebuilds them.', n_total, n_live;
  ELSE
    RAISE NOTICE '3514 rollback: public.layover_crew_location_grants does not exist; nothing to drop.';
  END IF;
END $$;

-- ── The four restrictive client denials ──────────────────────────────────────
DROP POLICY IF EXISTS layover_crew_location_grants_deny_select_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_insert_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_update_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_delete_clients ON public.layover_crew_location_grants;

DROP INDEX IF EXISTS public.layover_crew_location_grants_newest_idx;

-- The two CHECK constraints and the three FKs go with the table.
DROP TABLE IF EXISTS public.layover_crew_location_grants;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3514_layover_crew_location_grants.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- AFTER `COMMIT`, as 3514's own are: catalog state only, no row written and no
-- role assumed, so a failing assertion cannot roll back the DDL it asserts
-- about and the block can be re-run standalone.
DO $post$
DECLARE leftover INTEGER; coord_cols INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3514 rollback): layover_crew_location_grants still exists.';
  END IF;

  SELECT count(*) INTO leftover
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3514 rollback): % policy/policies remain on layover_crew_location_grants.', leftover;
  END IF;

  -- 2984's assertion, re-checked here as 3514 re-checked it: removing the thing
  -- that decides whether a position may be shown is the last moment at which a
  -- column to hold one should be allowed to appear next door.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crews','layover_crew_members')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3514 rollback): % coordinate column(s) on 2984''s crew tables. With the grant store gone there is nothing left to decide whether a position may be shown.', coord_cols;
  END IF;

  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3514_layover_crew_location_grants.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3514 rollback): the ledger still records 3514 as applied.';
  END IF;
END $post$;
