-- Rollback for 3787_layover_crew_location_grants.sql (census-layover L166, L203; B58 lane LAY-C1;
-- ported by content from PR #569's 3516 rollback, renumbered).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb) or to beta.
--
-- WHAT 3787 DID: created public.layover_crew_location_grants — RLS on, no
-- permissive policy, four RESTRICTIVE client-deny policies, service_role
-- grants, two CHECK constraints (positive window, revocation not before grant)
-- and layover_crew_location_grants_newest_idx — and seeded the flag
-- layover_crew_location_sharing_enabled FALSE. It added no coordinate column
-- anywhere and altered nothing that existed.
--
-- WHAT THIS ROLLBACK DOES:
--   1. REFUSES while layover_crew_location_sharing_enabled is TRUE. Dropping the
--      store under a live feature would make every grant route answer on a
--      table that is gone; turn the flag off deliberately first.
--   2. Reports the row count (total, and how many are unrevoked) BEFORE the
--      drop. A grant row is a traveller's own decision about their whereabouts;
--      nothing derives it and nothing rebuilds it, so an operator is told how
--      much consent history the rollback erases. It does not refuse on rows:
--      an absent store grants nothing, which is the same answer a revocation
--      gives, so dropping answers nothing on a traveller's behalf.
--   3. Drops the four policies, the index and the table, deletes the FALSE flag
--      row and 3787's ledger row.
-- Dropping the store returns the precision ladder to `never_granted` for
-- everybody — `none` and `meeting_point` only — which is what main served
-- before 3787. 2984's coordinate postcondition is not touched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_sharing_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3787): layover_crew_location_sharing_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DO $$
DECLARE n_total bigint := 0; n_live bigint := 0;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NOT NULL THEN
    EXECUTE 'SELECT count(*), count(*) FILTER (WHERE revoked_at IS NULL) FROM public.layover_crew_location_grants'
      INTO n_total, n_live;
    RAISE NOTICE '3787 rollback: dropping public.layover_crew_location_grants with % recorded act(s) of consent, of which % unrevoked. Each row is a traveller''s own decision to share their location; nothing derives them and nothing rebuilds them.', n_total, n_live;
  ELSE
    RAISE NOTICE '3787 rollback: public.layover_crew_location_grants does not exist; nothing to drop.';
  END IF;
END $$;

DROP POLICY IF EXISTS layover_crew_location_grants_deny_select_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_insert_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_update_clients ON public.layover_crew_location_grants;
DROP POLICY IF EXISTS layover_crew_location_grants_deny_delete_clients ON public.layover_crew_location_grants;

DROP INDEX IF EXISTS public.layover_crew_location_grants_newest_idx;

-- The two CHECK constraints and the three FKs go with the table.
DROP TABLE IF EXISTS public.layover_crew_location_grants;

DELETE FROM public.feature_flags WHERE flag = 'layover_crew_location_sharing_enabled' AND enabled = FALSE;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3787_layover_crew_location_grants.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- AFTER `COMMIT`, as 3787's own are: catalog state only.
DO $post$
DECLARE leftover INTEGER; coord_cols INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787 rollback): layover_crew_location_grants still exists.';
  END IF;

  SELECT count(*) INTO leftover
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787 rollback): % policy/policies remain on layover_crew_location_grants.', leftover;
  END IF;

  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_sharing_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787 rollback): the layover_crew_location_sharing_enabled row remains.';
  END IF;

  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crews','layover_crew_members')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787 rollback): % coordinate column(s) on 2984''s crew tables. With the grant store gone there is nothing left to decide whether a position may be shown.', coord_cols;
  END IF;

  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3787_layover_crew_location_grants.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787 rollback): the ledger still records 3787 as applied.';
  END IF;
END $post$;
