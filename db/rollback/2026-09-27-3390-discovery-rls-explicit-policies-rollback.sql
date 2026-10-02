-- Rollback for 3390_discovery_rls_explicit_policies.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness: apply → rollback → re-apply.
--
-- WHAT 3390 DID
-- =============
--   * On each present Discovery table: a RESTRICTIVE `false` policy, named
--     <table>_deny_<select|insert|update|delete>_<clients|anon>, for every
--     (operation, client role) that no existing permissive policy serves, and
--     REVOKE of the matching table privilege from that role.
--   * REVOKE TRUNCATE, REFERENCES, TRIGGER from anon and authenticated on each.
--   * REVOKE EXECUTE on rebuild_place_momentum / place_momentum_classify from
--     anon and authenticated.
--   It dropped no policy and touched no service_role privilege.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
--   * Drops every policy 3390 created (matched by name AND by its 3390 comment,
--     so a same-named policy somebody else wrote is left alone and reported).
--   * Re-grants EXACTLY the row-level-policed privileges (SELECT, INSERT,
--     UPDATE, DELETE) that the chain had granted and 3390 revoked. Read from the
--     chain, not guessed: the 2026-08-19 baseline grants ALL to anon and
--     authenticated on discovery_place_saves, discovery_place_reports,
--     discovery_cache, discovery_geocode_cache and rank_events, and no later
--     migration changed those five (2153 is discovery_places only). Every other
--     table's own migration had already revoked everything from the client
--     roles, or granted only the SELECT that 3390 keeps, so there is nothing to
--     re-grant there — and re-granting it would ADD a privilege that never
--     existed.
--
-- WHAT IT DELIBERATELY DOES NOT RESTORE
-- =====================================
--   * TRUNCATE, REFERENCES, TRIGGER. RLS does not police them; re-granting
--     TRUNCATE to anon would reopen the one hole a policy cannot close, and
--     2490 revokes them database-wide independently of 3390.
--   * EXECUTE on the two place_momentum functions for anon/authenticated. 2892
--     intended service_role only (it revoked FROM PUBLIC); the client grants
--     were an artefact of Supabase's default privileges, not a decision.
--   With all RLS-policed privileges restored and every 3390 policy dropped, the
--   posture every client request meets is exactly the pre-3390 one.

BEGIN;

DO $rb$
DECLARE
  pol record;
  foreign_named text[] := ARRAY[]::text[];
BEGIN
  FOR pol IN
    SELECT c.relname AS tbl, p.polname, p.polpermissive,
           obj_description(p.oid, 'pg_policy') AS cmt
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('discovery_places','discovery_place_saves','discovery_place_reports',
                         'discovery_cache','discovery_geocode_cache','discovery_shadow_serves',
                         'discovery_place_photos','place_momentum','trails','content_trails',
                         'trail_edges','trail_follows','trail_reports','trail_health_snapshots',
                         'recommendations','rank_events')
       AND p.polname ~ ('^' || c.relname || '_deny_(select|insert|update|delete)_(clients|anon)$')
  LOOP
    IF NOT pol.polpermissive AND coalesce(pol.cmt, '') LIKE '3390 %' THEN
      EXECUTE format('DROP POLICY %I ON public.%I', pol.polname, pol.tbl);
    ELSE
      foreign_named := foreign_named || format('%s.%s', pol.tbl, pol.polname);
    END IF;
  END LOOP;
  IF array_length(foreign_named, 1) > 0 THEN
    RAISE NOTICE '3390 rollback: left alone, name matches but not written by 3390: %', array_to_string(foreign_named, ', ');
  END IF;

  IF to_regclass('public.discovery_place_saves') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_place_saves TO anon;
    GRANT UPDATE, DELETE ON public.discovery_place_saves TO authenticated;
  END IF;
  IF to_regclass('public.discovery_place_reports') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_place_reports TO anon;
    GRANT UPDATE, DELETE ON public.discovery_place_reports TO authenticated;
  END IF;
  IF to_regclass('public.discovery_cache') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_cache TO anon, authenticated;
  END IF;
  IF to_regclass('public.discovery_geocode_cache') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_geocode_cache TO anon, authenticated;
  END IF;
  IF to_regclass('public.rank_events') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.rank_events TO anon;
    GRANT INSERT, UPDATE, DELETE ON public.rank_events TO authenticated;
  END IF;

  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3390_discovery_rls_explicit_policies.sql';
  END IF;
END $rb$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND coalesce(obj_description(p.oid, 'pg_policy'), '') LIKE '3390 %';
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3390 rollback): % policy(ies) written by 3390 remain.', n;
  END IF;
  IF to_regclass('public.discovery_place_saves') IS NOT NULL
     AND NOT has_table_privilege('anon', 'public.discovery_place_saves', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3390 rollback): the baseline anon privileges on discovery_place_saves were not restored.';
  END IF;
  IF to_regclass('public.rank_events') IS NOT NULL
     AND NOT has_table_privilege('authenticated', 'public.rank_events', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3390 rollback): the baseline authenticated privileges on rank_events were not restored.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3390_discovery_rls_explicit_policies.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3390 rollback): the ledger still records 3390 as applied.';
  END IF;
END $post$;
