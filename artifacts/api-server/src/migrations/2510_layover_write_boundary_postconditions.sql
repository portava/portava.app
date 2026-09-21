-- 2510_layover_write_boundary_postconditions.sql
--
-- The postcondition block that 2335_layover_recommendation_write_boundary.sql
-- does not have. VERIFY-ONLY: this file changes nothing. It raises if the
-- boundary 2335 claims is not in force on the database it runs against, and
-- it passes silently when it is.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2510.
-- Idempotent (pure assertions; re-runnable at any time as a standing audit).
-- Creates nothing, drops nothing, grants nothing, revokes nothing, writes no
-- row, flips no flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A SEPARATE FILE AND NOT AN EDIT TO 2335
-- ══════════════════════════════════════════════════════════════════════════════
-- 2335 was applied to portava-ci on 2026-09-07 and its ledger row carries the
-- sha256 of the file as committed (efe7172d…, equal to the file on disk today).
-- check:migration-ledger reports an edited applied migration as its own finding
-- — "the database ran the old content and nothing will ever run the difference"
-- — so the missing assertions cannot be added to 2335 in place without turning
-- that gate red. They live here instead, numbered after everything 2335 relies
-- on, and they assert the state 2335 leaves behind rather than re-creating it:
-- re-issuing 2335's DDL here would make two files claim the same change.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS ASSERTED, AND WHAT WAS MEASURED (2026-09-07, aclexplode + pg_policies)
-- ══════════════════════════════════════════════════════════════════════════════
-- Every policy on layover_recommendations, in BOTH databases: exactly one,
-- `layover_recs_owner`, PERMISSIVE, TO authenticated. There is no second policy
-- that could OR-dominate it. What differs is its command and the grants:
--
--   portava-ci   hwokxgbmezheskbzskfr   cmd=SELECT   authenticated=SELECT
--                (2335 applied)          service_role=SELECT,INSERT,UPDATE,DELETE
--                                        anon=(nothing)
--   production   ajrurzioarfkagpuxfnb   cmd=ALL, with_check=NULL
--                (2335 NOT applied)      anon, authenticated = DELETE,INSERT,
--                                        MAINTAIN,REFERENCES,SELECT,TRIGGER,
--                                        TRUNCATE,UPDATE
--
-- On production, therefore, this file FAILS today — that is the point. It is
-- the loud signal that 2335 has not been applied, and it must be run AFTER
-- 2335, never instead of it.
--
-- Assertions, each one a fact 2335's header promises:
--   1. RLS is enabled on layover_recommendations.
--   2. Exactly one policy exists on it, named layover_recs_owner, FOR SELECT,
--      PERMISSIVE, to {authenticated} only. (A FOR ALL policy with no WITH
--      CHECK reuses USING as its write check — the original defect.)
--   3. authenticated holds SELECT and NOT INSERT / UPDATE / DELETE / TRUNCATE.
--   4. anon holds nothing at all — not even SELECT — and PUBLIC holds nothing
--      (has_table_privilege('anon', …) sees PUBLIC grants too).
--   5. service_role holds SELECT, INSERT, UPDATE, DELETE and NOT TRUNCATE —
--      the only writer, and TRUNCATE is the one verb RLS does not police.
--   6. anon and authenticated hold NO TRUNCATE on the four sibling tables
--      (2335 section 2): layover_sessions, layover_events, layover_plan_stops,
--      airport_profiles.
--
-- Not asserted: MAINTAIN (PG17) on the sibling tables. 2335 leaves it in place
-- along with REFERENCES and TRIGGER; PostgREST exposes no verb that uses any of
-- them. Narrowing those is an owner decision, not a postcondition of 2335.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.layover_recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.layover_recommendations missing -- apply 0127 first.';
  END IF;
  IF to_regclass('public.layover_sessions') IS NULL
     OR to_regclass('public.layover_events') IS NULL
     OR to_regclass('public.layover_plan_stops') IS NULL
     OR to_regclass('public.airport_profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: a sibling layover table from 0127 is missing.';
  END IF;
END $$;

-- ── POSTCONDITIONS OF 2335 ───────────────────────────────────────────────────
DO $$
DECLARE
  rls_on      BOOLEAN;
  pol_count   INTEGER;
  pol_cmd     TEXT;
  pol_perm    BOOLEAN;
  pol_roles   TEXT;
  t           TEXT;
  r           TEXT;
BEGIN
  -- 1. RLS enabled.
  SELECT c.relrowsecurity INTO rls_on
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'layover_recommendations';
  IF rls_on IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): RLS is not enabled on layover_recommendations';
  END IF;

  -- 2. Exactly one policy, and it is the SELECT-only owner read.
  SELECT count(*) INTO pol_count
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layover_recommendations';
  IF pol_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): expected exactly 1 policy on layover_recommendations, found % -- a second PERMISSIVE policy would OR-dominate layover_recs_owner', pol_count;
  END IF;

  SELECT p.polcmd::text, p.polpermissive,
         coalesce((SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE oid = ANY (p.polroles)), 'public')
    INTO pol_cmd, pol_perm, pol_roles
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'layover_recommendations' AND p.polname = 'layover_recs_owner';
  IF pol_cmd IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): policy layover_recs_owner is absent';
  END IF;
  IF pol_cmd <> 'r' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): layover_recs_owner is polcmd=% (r=SELECT, *=ALL); a FOR ALL policy with no WITH CHECK lets a session owner write safety_rating / return_buffer_min / hard_return_time -- 2335 has not been applied', pol_cmd;
  END IF;
  IF pol_perm IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): layover_recs_owner is RESTRICTIVE; with no permissive policy every read is denied';
  END IF;
  IF pol_roles <> 'authenticated' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): layover_recs_owner applies to {%}, expected {authenticated}', pol_roles;
  END IF;

  -- 3. authenticated: SELECT only.
  IF NOT has_table_privilege('authenticated', 'public.layover_recommendations', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): authenticated lost SELECT on layover_recommendations -- the dashboard read would break';
  END IF;
  FOREACH r IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.layover_recommendations', r) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2335): authenticated still holds % on layover_recommendations -- the certified safety fields are client-writable', r;
    END IF;
  END LOOP;

  -- 4. anon (and PUBLIC, which has_table_privilege folds in): nothing.
  FOREACH r IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.layover_recommendations', r) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2335): anon holds % on layover_recommendations -- 2335 grants the unauthenticated role nothing', r;
    END IF;
  END LOOP;

  -- 5. service_role: the DML the routes need, and no TRUNCATE.
  FOREACH r IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.layover_recommendations', r) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2335): service_role lacks % on layover_recommendations -- LayoverRecommendationService would fail on the only writer', r;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.layover_recommendations', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2335): service_role holds TRUNCATE on layover_recommendations; nothing truncates it and RLS does not police TRUNCATE';
  END IF;

  -- 6. Siblings: TRUNCATE taken back from the client roles.
  FOREACH t IN ARRAY ARRAY['layover_sessions', 'layover_events', 'layover_plan_stops', 'airport_profiles'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(r, format('public.%I', t), 'TRUNCATE') THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (2335 section 2): % still holds TRUNCATE on % -- RLS does not police TRUNCATE', r, t;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
