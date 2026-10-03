-- Rollback for 3515_layover_crew_itinerary.sql (spec §14.1 / census-layover L135, lane 3515).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- REHEARSED 2026-10-03 on PostgreSQL 16, and here is exactly what that covered.
-- The cycle apply / re-apply / rollback / rollback-again / re-apply ran clean,
-- every postcondition block passed, and the NOTICE printed the real counts from
-- seeded rows (1 crew stop, 0 branch assignments) rather than placeholders. The
-- second rollback run reports ABSENCE rather than a count of zero, because
-- "0 stops" would tell an operator nothing was lost and this file cannot know
-- that once the table is gone.
--
-- WHAT THE REHEARSAL DID NOT COVER, said plainly rather than left implied: it
-- ran on a scratch database carrying minimal stand-ins for `profiles`,
-- `layover_crews` and `layover_sessions`, not the full migration chain, so it
-- proves this file's own SQL, its postconditions and its idempotency — not how
-- it behaves against a database with the real parent tables and their data.
--
-- WHAT 3515 DID: created public.layover_crew_stops and
-- public.layover_crew_branch_assignments — each with RLS on, no permissive
-- policy, four RESTRICTIVE client-deny policies (eight in all) and
-- service_role grants — plus layover_crew_stops_crew_idx and
-- layover_crew_branch_assignments_crew_idx. It altered nothing that existed.
--
-- WHAT THIS ROLLBACK DOES: drops the eight restrictive policies, the two
-- indexes and the two tables, then 3515's ledger row. It does not refuse, and
-- nothing in 3515 is left standing: both tables are new in that file, so the
-- drop returns the crew surface to `unsplitPlan(members, [])` — one branch
-- `'all'`, everybody, no stops — which is what every caller got before it.
--
-- WHAT IS LOST, STATED RATHER THAN HIDDEN: DROPPING THESE TABLES DISCARDS A
-- CREW'S ITINERARY. Every stop a member proposed (its title, duration, measured
-- journey and location label) and every branch assignment go with the tables,
-- and nothing in the product derives them: they exist only because a traveller
-- typed them in. There is no projection, snapshot or sweep that can rebuild
-- one, so the only recovery is the crew re-entering the whole plan by hand —
-- and a crew whose layover has since ended cannot do even that.
--
-- ORDER: assignments before stops is not required by the database (there is no
-- FK between the two tables, as 3515's header says) but is the order its
-- header names, and the policies and indexes are dropped by name first. DROP
-- TABLE would remove both on its own; they are written down so this file reads
-- as the reverse of 3515 rather than relying on a cascade to be read into it.

BEGIN;

DO $$
DECLARE n_stops bigint := 0; n_assign bigint := 0; present boolean := false;
BEGIN
  -- A COUNT OF 0 AND AN ABSENT TABLE ARE DIFFERENT FACTS, and the difference is
  -- the whole point of printing the count. "0 crew stop(s)" tells the operator
  -- nothing was lost; an absent table means this file cannot tell them whether
  -- anything was lost, because whatever dropped it did not say. So absence is
  -- reported as absence, exactly as 3516's rollback reports it, and the count is
  -- printed only when there was something to count it from.
  IF to_regclass('public.layover_crew_stops') IS NOT NULL THEN
    present := true;
    EXECUTE 'SELECT count(*) FROM public.layover_crew_stops' INTO n_stops;
  END IF;
  IF to_regclass('public.layover_crew_branch_assignments') IS NOT NULL THEN
    present := true;
    EXECUTE 'SELECT count(*) FROM public.layover_crew_branch_assignments' INTO n_assign;
  END IF;
  IF present THEN
    RAISE NOTICE '3515 rollback: dropping the crew itinerary — % crew stop(s) and % branch assignment(s). Nothing derives them; a crew can only get them back by re-entering them.', n_stops, n_assign;
  ELSE
    RAISE NOTICE '3515 rollback: neither public.layover_crew_stops nor public.layover_crew_branch_assignments exists; nothing to drop, and nothing can be said about what they held.';
  END IF;
END $$;

-- ── The eight restrictive client denials ─────────────────────────────────────
DROP POLICY IF EXISTS layover_crew_stops_deny_select_clients ON public.layover_crew_stops;
DROP POLICY IF EXISTS layover_crew_stops_deny_insert_clients ON public.layover_crew_stops;
DROP POLICY IF EXISTS layover_crew_stops_deny_update_clients ON public.layover_crew_stops;
DROP POLICY IF EXISTS layover_crew_stops_deny_delete_clients ON public.layover_crew_stops;
DROP POLICY IF EXISTS layover_crew_branch_assignments_deny_select_clients ON public.layover_crew_branch_assignments;
DROP POLICY IF EXISTS layover_crew_branch_assignments_deny_insert_clients ON public.layover_crew_branch_assignments;
DROP POLICY IF EXISTS layover_crew_branch_assignments_deny_update_clients ON public.layover_crew_branch_assignments;
DROP POLICY IF EXISTS layover_crew_branch_assignments_deny_delete_clients ON public.layover_crew_branch_assignments;

-- ── The two indexes ──────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.layover_crew_branch_assignments_crew_idx;
DROP INDEX IF EXISTS public.layover_crew_stops_crew_idx;

-- ── The two tables ───────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.layover_crew_branch_assignments;
DROP TABLE IF EXISTS public.layover_crew_stops;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3515_layover_crew_itinerary.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- AFTER `COMMIT`, as 3515's own are: catalog state only, no row written and no
-- role assumed, so a failing assertion cannot roll back the DDL it asserts
-- about and the block can be re-run standalone.
DO $post$
DECLARE leftover INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_stops') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3515 rollback): layover_crew_stops still exists.';
  END IF;
  IF to_regclass('public.layover_crew_branch_assignments') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3515 rollback): layover_crew_branch_assignments still exists.';
  END IF;

  -- No policy may outlive its table: a stray row here would mean a table of one
  -- of these names was re-created between the drop and this block.
  SELECT count(*) INTO leftover
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('layover_crew_stops','layover_crew_branch_assignments');
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3515 rollback): % policy/policies remain on the crew itinerary tables.', leftover;
  END IF;

  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3515_layover_crew_itinerary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3515 rollback): the ledger still records 3515 as applied.';
  END IF;
END $post$;
