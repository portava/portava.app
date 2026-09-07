-- 2490_destructive_privilege_boundary.sql
--
-- `anon` and `authenticated` stop holding the four table privileges that row
-- level security does not police.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2490.
--
-- Privilege-only. Creates nothing, drops nothing, writes no row, flips no flag,
-- adds/alters/drops no RLS policy, and touches no DML privilege. Idempotent
-- (REVOKE is a no-op when the privilege is already absent).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: 2333 FIXED FOUR TABLES OF THREE HUNDRED AND SEVENTY-FOUR
-- ══════════════════════════════════════════════════════════════════════════════
-- 2333_derived_memory_and_consent_grant_boundary.sql argues, correctly, that
-- TRUNCATE is the exception to "RLS with no policy denies everything", because
-- PostgreSQL does not apply row-level security to TRUNCATE. It then revokes on
-- the four derived-memory tables it was scoped to.
--
-- That argument does not stop at four tables. Measured 2026-09-07:
--
--   database                        tables in public   anon holds TRUNCATE on
--   travel-buddy (production)              417                  374
--   portava-ci                             438                  357
--
-- Of production's 374: 373 have RLS ENABLED and 312 carry policies. Every one of
-- those 312 is a table whose designer thought about who may read and write it,
-- wrote a policy to say so, and left `anon` — the UNAUTHENTICATED public role —
-- holding a privilege that discards the whole table without consulting that
-- policy once.
--
-- 43 tables do NOT have it. They are the ones 2217, 2332 and their siblings
-- already hardened with the REVOKE-then-GRANT pattern. This migration is not a
-- new idea; it is that same idea, finished, in one statement instead of forty.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FOUR PRIVILEGES, AND WHY THESE FOUR AND NOT THE OTHER FOUR
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase's ALTER DEFAULT PRIVILEGES hands `anon`, `authenticated` and
-- `service_role` the full set `arwdDxtm` on every table created in `public`.
-- Read as ACL letters that is:
--
--   a INSERT   r SELECT   w UPDATE   d DELETE   <- policed by RLS
--   D TRUNCATE x REFERENCES t TRIGGER m MAINTAIN <- NOT policed by RLS
--
-- The first four are row-scoped: a policy decides, per row, whether the role may
-- see or change it. The second four are table-scoped. RLS never consults them.
-- A policy cannot restrict them, narrow them, or log them.
--
-- Only the second four are revoked here. The DML four are left exactly as they
-- are, deliberately: they are the ones a real client path may use under a real
-- policy, and narrowing them table-by-table is per-surface work with per-surface
-- evidence (2332, 2333, 2335 and 2370 are that work). Mixing it into a
-- database-wide sweep would be how a sweep breaks a feature.
--
-- ── Why revoking these four cannot break a caller ────────────────────────────
--   TRUNCATE   PostgREST exposes no TRUNCATE verb. Nothing in
--              artifacts/api-server reaches a table except through supabase-js
--              (SELECT/INSERT/UPDATE/DELETE/RPC) or an RPC running as
--              service_role, whose privileges are untouched below.
--   REFERENCES Creating a foreign key requires CREATE on the schema.
--              has_schema_privilege('anon','public','CREATE') = false, and the
--              same for `authenticated`. Measured, both databases.
--   TRIGGER    Same: attaching a trigger requires ownership of the table and a
--              function to attach. Neither role owns anything; 416 of the 417
--              public tables are owned by `postgres`.
--   MAINTAIN   PostgreSQL 17 (this server is 17.6). VACUUM/ANALYZE/REINDEX/
--              CLUSTER/REFRESH MATERIALIZED VIEW. No client path runs
--              maintenance, and maintenance is not something an unauthenticated
--              key should be able to schedule against a production table.
--
-- service_role is NOT touched. It is the server's own identity, it is BYPASSRLS
-- by design, and the account-deletion and purge paths depend on it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE HALF THIS MIGRATION CANNOT REACH — STATED, NOT HIDDEN
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. FUTURE TABLES. Revoking on existing tables does nothing for the next one
--    created; ALTER DEFAULT PRIVILEGES is what stops the grant being re-issued.
--    `pg_default_acl` carries rows for TWO grantor roles in schema public:
--
--      postgres        / r / anon=arwdDxtm, authenticated=arwdDxtm, ...
--      supabase_admin  / r / anon=arwdDxtm, authenticated=arwdDxtm, ...
--
--    ALTER DEFAULT PRIVILEGES may only be issued FOR ROLE a role you are a
--    member of. `postgres` is a member of anon, authenticated, authenticator,
--    service_role, supabase_privileged_role and four pg_* roles — it is NOT a
--    member of `supabase_admin`. So the `postgres` default is fixed below and
--    the `supabase_admin` default CANNOT BE FIXED FROM A MIGRATION.
--
--    Practical exposure of that residue: a table created BY supabase_admin in
--    schema public would inherit the blanket set again. In production exactly
--    one such table exists — `spatial_ref_sys`, PostGIS's own coordinate-system
--    reference data, which holds no user data and which this migration cannot
--    revoke on either (postgres does not own it). Application tables are all
--    created by `postgres`. This is recorded as a residual, not as done.
--
-- 2. CI DRIFT. portava-ci shows 357/438 rather than production's 374/417. The
--    two are the same posture; the numbers differ because CI carries tables
--    production does not. Apply to portava-ci FIRST and read the postcondition
--    there before touching production.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- Restoring the previous state means re-granting a capability that no code path
-- uses, so there is no rollback file. If a table is later found to genuinely
-- need one of these four for a named role, grant it back on THAT table with the
-- reason recorded, rather than reverting the sweep.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── existing tables ─────────────────────────────────────────────────────────
-- `ON ALL TABLES IN SCHEMA` expands to every table, view and foreign table in
-- `public` at execution time. Objects the current role cannot revoke on
-- (spatial_ref_sys) raise a WARNING and are skipped; that is expected and is
-- why the postcondition below excludes it by name rather than by silence.

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

-- ─── tables created from here on ─────────────────────────────────────────────
-- Without this, the next CREATE TABLE re-issues the full blanket set and the
-- sweep above decays from the day it is applied.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — this migration fails loudly rather than silently no-opping
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_examined  int;
  v_offending int;
  v_names     text;
  v_default   int;
BEGIN
  -- VACUITY GUARD. A check that examines nothing must fail, not pass. If this
  -- ever runs against a schema with no application tables, the two counts below
  -- would both be zero and the migration would report success having done
  -- nothing at all.
  SELECT count(*) INTO v_examined
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','f');

  IF v_examined < 300 THEN
    RAISE EXCEPTION
      '2490 postcondition VACUOUS: only % relations found in schema public; expected 300+ (production 417, portava-ci 438). Refusing to report success on an empty sweep.',
      v_examined;
  END IF;

  -- 1. No relation in public still grants any of the four to anon or
  --    authenticated. spatial_ref_sys is excluded BY NAME because it is owned by
  --    supabase_admin and is unreachable from this migration (see header).
  SELECT count(*), string_agg(rel, ', ' ORDER BY rel)
    INTO v_offending, v_names
    FROM (
      SELECT DISTINCT c.relname AS rel
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) x
        JOIN pg_roles r ON r.oid = x.grantee
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r','p','v','f')
         AND c.relname <> 'spatial_ref_sys'
         AND r.rolname IN ('anon','authenticated')
         AND x.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
    ) s;

  IF v_offending > 0 THEN
    RAISE EXCEPTION
      '2490 postcondition FAILED: % relation(s) still grant TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to anon or authenticated: %',
      v_offending, v_names;
  END IF;

  -- 2. The postgres default ACL no longer re-issues them to future tables.
  SELECT count(*) INTO v_default
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
    JOIN pg_roles r ON r.oid = x.grantee
   WHERE n.nspname = 'public'
     AND d.defaclobjtype = 'r'
     AND pg_get_userbyid(d.defaclrole) = 'postgres'
     AND r.rolname IN ('anon','authenticated')
     AND x.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN');

  IF v_default > 0 THEN
    RAISE EXCEPTION
      '2490 postcondition FAILED: the postgres default ACL for schema public still grants % of the four to anon/authenticated; new tables would re-inherit them.',
      v_default;
  END IF;

  RAISE NOTICE '2490 OK: % relations examined, 0 still grant TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to anon or authenticated, postgres default ACL clean. Residual: supabase_admin default ACL (unreachable, see header).', v_examined;
END $$;

COMMIT;
