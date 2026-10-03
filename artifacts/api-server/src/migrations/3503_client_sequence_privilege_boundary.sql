-- 3503_client_sequence_privilege_boundary.sql
--
-- `anon` and `authenticated` stop holding any privilege on any sequence in
-- schema public, and stop being handed one by default for the next sequence.
-- `telegraph_report_evidence` (2812) stops granting the two client roles the
-- table privileges its row-level security leaves inert.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
--
-- Privilege-only. Creates nothing, drops nothing, writes no row, flips no flag,
-- adds/alters/drops no RLS policy, and does not touch service_role. Idempotent:
-- REVOKE is a no-op when the privilege is already absent.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: A CLIENT KEY CAN MOVE EVERY ID COUNTER IN THE SCHEMA
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase's default privileges for sequences created in public, for BOTH
-- grantor roles, are
--
--     postgres        / S / anon=rwU, authenticated=rwU, service_role=rwU
--     supabase_admin  / S / anon=rwU, authenticated=rwU, service_role=rwU
--
-- (r SELECT = currval/last_value, w UPDATE = setval/nextval, U USAGE = nextval).
-- 2490 closed the four table privileges RLS does not police. Sequences are the
-- same hole one object kind over: row-level security has no notion of a
-- sequence, so nothing at all stands between a client key and `setval`.
--
-- Measured 2026-10-03 by read-only SELECTs:
--
--   database                         sequences in public   anon/authenticated hold UPDATE on
--   travel-buddy (testing, "prod")             10                       10
--   portava-ci                                 12                       12
--
-- All are owned by `postgres`; none is extension-owned. On a production-shaped
-- local replica, `SET ROLE anon; SELECT setval('public.feature_flag_audit_log_
-- id_seq', 1000000)` succeeded. Moving a counter BACK makes the next server
-- INSERT on that table collide on its primary key, so any client key could stop
-- the audit, outbox, telemetry and trip-reservation writers that draw from these
-- sequences. That is an availability break, not a disclosure.
--
-- ── Why revoking every client sequence privilege cannot break a caller ──────
-- A client role needs USAGE on a sequence only to INSERT a row whose default is
-- nextval() of it. Measured on both databases, for every table that owns one of
-- these sequences:
--   * eight grant the client roles no INSERT at all;
--   * feature_flag_audit_log grants INSERT but has RLS on and NO policy, so a
--     client insert is refused before the default is evaluated;
--   * ranking_debug_samples grants INSERT but its only policy is
--     `rds_no_public_select` (FOR ALL, USING false), which refuses it likewise.
-- No client can insert into any of them, so no client draws from any of them.
-- Independently, the mobile app (travel-buddy-standalone) issues no `.insert(`
-- or `.rpc(` through supabase-js, and the API server never builds a
-- user-scoped Supabase client: every write runs as service_role, whose
-- privileges are untouched and are asserted below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- telegraph_report_evidence (2812)
-- ══════════════════════════════════════════════════════════════════════════════
-- 2812 created the table under postgres's default table ACL, so anon and
-- authenticated hold `arwd` on it (2490 already removed TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN). RLS is ON with ZERO policies, so today those four reach
-- no row. They are still a standing grant on an evidence table: the first
-- permissive policy anyone adds would expose report evidence to client keys.
-- The table is read and written only by services/telegraphReportEvidence.ts and
-- lib/reportTargetAccess.ts, which run as service_role. 2812 is not applied on
-- every database yet (the testing database has not run it), so the revoke is
-- conditional on the table existing. The applier runs files in byte order, so
-- wherever both are pending 2812 lands first and this revoke reaches it. A hand
-- apply of 2812 AFTER this file would re-inherit `arwd` from postgres's default
-- table ACL; re-running this file (idempotent) closes it again.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE HALF THIS MIGRATION CANNOT REACH — STATED, NOT HIDDEN
-- ══════════════════════════════════════════════════════════════════════════════
-- The supabase_admin default ACL for sequences. ALTER DEFAULT PRIVILEGES may
-- only be issued FOR ROLE a role the current role is a member of; `postgres` is
-- not a member of `supabase_admin` (2490 measured this). A sequence created BY
-- supabase_admin in public would inherit rwU again. Application sequences are
-- all created by `postgres`; supabase_admin creates extension objects, and the
-- postconditions exclude extension-owned sequences for exactly that reason.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- None, as with 2490: restoring the previous state re-grants a capability no
-- code path uses. If a table ever genuinely needs client inserts, GRANT USAGE on
-- THAT table's sequence to THAT role, with the reason recorded.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── existing sequences ──────────────────────────────────────────────────────
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, PUBLIC;

-- ─── sequences created from here on ──────────────────────────────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM authenticated;

-- ─── telegraph_report_evidence (2812), where it exists ───────────────────────
DO $$
BEGIN
  IF to_regclass('public.telegraph_report_evidence') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.telegraph_report_evidence FROM anon, authenticated, PUBLIC;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — this migration fails loudly rather than silently no-opping
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_examined  int;
  v_offending int;
  v_names     text;
  v_default   int;
  v_svc       text;
BEGIN
  -- VACUITY GUARD. Both databases hold 10+ application sequences; a schema with
  -- fewer than 5 means this ran somewhere that is not a Portava database, and a
  -- sweep over nothing must not report success.
  SELECT count(*) INTO v_examined
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e' AND d.classid = 'pg_class'::regclass);

  IF v_examined < 5 THEN
    RAISE EXCEPTION
      '3503 postcondition VACUOUS: only % non-extension sequences in schema public; expected 10+ (testing 10, portava-ci 12).',
      v_examined;
  END IF;

  -- 1. No non-extension sequence in public grants anything to a client role.
  SELECT count(*), string_agg(relname, ', ' ORDER BY relname)
    INTO v_offending, v_names
    FROM (
      SELECT DISTINCT c.relname
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.objid = c.oid AND d.deptype = 'e' AND d.classid = 'pg_class'::regclass)
         AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon','authenticated'))
    ) s;

  IF v_offending > 0 THEN
    RAISE EXCEPTION
      '3503 postcondition FAILED: % sequence(s) in public still grant a privilege to anon, authenticated or PUBLIC: %',
      v_offending, v_names;
  END IF;

  -- 2. The postgres default ACL no longer issues sequence privileges to them.
  SELECT count(*) INTO v_default
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
   WHERE d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype = 'S'
     AND pg_get_userbyid(d.defaclrole) = 'postgres'
     AND pg_get_userbyid(x.grantee) IN ('anon','authenticated');

  IF v_default > 0 THEN
    RAISE EXCEPTION
      '3503 postcondition FAILED: the postgres default ACL for sequences in public still grants % privilege(s) to anon/authenticated.',
      v_default;
  END IF;

  -- 3. The server is untouched: service_role still draws from every sequence.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_svc
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e' AND d.classid = 'pg_class'::regclass)
     -- CASE, not AND: the planner may evaluate this before relkind = 'S', and
     -- has_sequence_privilege raises on a non-sequence ("geometry_dump" is
     -- not a sequence) — seen on the first rehearsal.
     AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege('service_role', c.oid, 'USAGE') ELSE false END;

  IF v_svc IS NOT NULL THEN
    RAISE EXCEPTION
      '3503 postcondition FAILED: service_role lacks USAGE on: % (this migration must never narrow the server).',
      v_svc;
  END IF;

  -- 4. telegraph_report_evidence, where it exists, grants the client roles nothing.
  IF to_regclass('public.telegraph_report_evidence') IS NOT NULL THEN
    IF has_table_privilege('anon', 'public.telegraph_report_evidence', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.telegraph_report_evidence', 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION '3503 postcondition FAILED: telegraph_report_evidence still grants DML to anon or authenticated.';
    END IF;
  END IF;

  RAISE NOTICE '3503 OK: % sequences examined, none grants anon/authenticated/PUBLIC anything, postgres default ACL clean, service_role intact. Residual (unreachable from a migration, see header): the supabase_admin default ACL for sequences.', v_examined;
END $$;

COMMIT;
