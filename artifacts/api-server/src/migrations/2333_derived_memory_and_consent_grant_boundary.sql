-- 2333_derived_memory_and_consent_grant_boundary.sql
--
-- The derived-memory tables and five consent//intel tables stop resting on
-- Supabase's default privileges and start resting on an explicit grant set.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2333.
--
--
-- ══════════════════════════════════════════════════════════════════════════════
-- CORRECTION 2026-09-07 — TWO CLAIMS IN THIS HEADER WERE WRONG
-- ══════════════════════════════════════════════════════════════════════════════
-- A postcondition block was added to this file (it previously had none), and its
-- vacuity guard immediately failed against production. Two corrections follow.
--
-- 1. THIS FILE WOULD HAVE ABORTED ON PRODUCTION. Two of the eight tables it
--    names DO NOT EXIST in travel-buddy (ajrurzioarfkagpuxfnb):
--
--      route_flow_contribution_consent  -- created by 2224_route_hop_signal.sql
--      sensing_anon_contributions       -- created by 2315_sensing_anon_contributions.sql
--
--    Both migrations are themselves unapplied to production. `REVOKE ALL ON
--    public.route_flow_contribution_consent` against a relation that does not
--    exist is an ERROR, not a no-op, so the whole transaction would have rolled
--    back and NONE of the memory revokes would have landed. The dependency is
--    now declared and enforced by the PRECONDITION block below, so the failure
--    is a directive message instead of "relation does not exist".
--
--    => 2333 REQUIRES 2224 AND 2315 ON PRODUCTION. This ordering was absent from
--       docs/architecture/manual-production-migration-runbook.md §B2 and has
--       been added there.
--
-- 2. "Read on 2026-09-07 from BOTH databases" IS FALSE FOR THOSE TWO TABLES.
--    They exist only on portava-ci. The FINDING 2 table below reports "ALL (8)"
--    for all eight rows; that reading is correct for the six that exist in both,
--    and for the other two it was a portava-ci reading generalised to production
--    without being taken there. The six rows stand as measured; the two are
--    marked in place.
--
-- ── APPLIED STATE, measured rather than assumed ──────────────────────────────
--    portava-ci  : APPLIED. anon and authenticated hold NOTHING on all four
--                  derived-memory tables, and service_role holds exactly the
--                  eight narrowed sets granted below, byte for byte.
--    production  : NOT APPLIED. All four derived-memory tables still grant the
--                  full blanket set to anon AND authenticated.
--    The two databases have drifted on this file. Production is the one behind.
--
-- ── SEE ALSO ────────────────────────────────────────────────────────────────
--    2490_destructive_privilege_boundary.sql subsumes the TRUNCATE half of
--    FINDING 1 database-wide (374 of 417 production tables, not four).
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Same class as 2332_money_grant_boundary.sql, extended to the tables that
-- 2332 did not cover. Privilege-only: it creates nothing, drops nothing, writes
-- no row, flips no flag, and does not add, alter or drop a single RLS policy.
-- Idempotent (REVOKE-then-GRANT), so re-running it is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE LIVE GRANT SET, MEASURED — NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read on 2026-09-07 from BOTH databases via aclexplode(pg_class.relacl), the
-- query that sees every privilege including PG17's MAINTAIN:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
-- ── FINDING 1 — the serious one. PRODUCTION AND CI, IDENTICAL. ───────────────
-- All four derived-memory tables grant the FULL set
--
--   DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- to `anon` AND `authenticated` AND `service_role`:
--
--   memory_events   memory_feedback   memory_policy   memory_projections
--
-- `anon` is the UNAUTHENTICATED public role. No migration asked for this; it is
-- what ALTER DEFAULT PRIVILEGES on the `public` schema hands out at CREATE TABLE
-- time, and 2183/2192 never took it back.
--
-- WHY THIS IS NOT A LIVE BREACH, AND WHY IT IS STILL A DEFECT.
-- All four have RLS ENABLED with ZERO policies in both databases (verified via
-- pg_class.relrowsecurity + pg_policies). RLS with no policy denies every
-- non-BYPASSRLS role, so no row is readable or writable by anon today. The grant
-- is inert for SELECT/INSERT/UPDATE/DELETE.
--
-- TRUNCATE IS THE EXCEPTION. PostgreSQL does NOT apply row-level security to
-- TRUNCATE. A role holding TRUNCATE empties the table whatever the policies say.
-- So for these four production tables the only thing standing between the public
-- anon key and an instant wipe of every derived memory row is that PostgREST
-- exposes no TRUNCATE verb. That is an absent verb, not a permission — and it is
-- not a boundary this repository should be relying on.
--
-- SCOPE NOTE, added 2026-09-07 after 2490 was written. The argument in the
-- paragraph above is correct and it is not specific to these four tables:
-- measured the same day, 374 of production's 417 public tables grant TRUNCATE
-- to `anon`, 312 of them while carrying RLS policies. 2490_destructive_privilege
-- _boundary.sql revokes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from anon and
-- authenticated across the whole schema and fixes the default ACL so new tables
-- do not re-inherit them. This file is still the right place for the DML
-- narrowing below -- that is per-table work needing per-table evidence -- but
-- the TRUNCATE half of FINDING 1 is subsumed by 2490 and the two are
-- independent: either may be applied first, and applying both is idempotent.
--
-- Because there are zero policies, revoking cannot break a legitimate caller:
-- there is no anon/authenticated path through these tables to break. The revoke
-- is pure subtraction of unreachable-but-real capability.
--
-- ── FINDING 2 — the narrower one, service_role only. ─────────────────────────
-- Eight tables hold the full ALL set for `service_role` even though their own
-- migration enumerated a NARROW subset. The migration states an intent that the
-- database does not have. Measured, with the intent each file expressed:
--
--   TABLE                             MIGRATION GRANTED        ACTUALLY HELD
--   memory_events                     INSERT,SELECT,DELETE     ALL (8)
--   memory_feedback                   INSERT,SELECT,UPDATE,DEL ALL (8)
--   memory_projections                INSERT,SELECT,UPDATE,DEL ALL (8)
--   memory_policy                     SELECT                   ALL (8)
--   intel_contribution_consent        SELECT,INSERT,UPDATE(+DELETE via 2203)  ALL (8)
--   intel_live_promoted_scopes        SELECT,INSERT,UPDATE,DEL ALL (8)
--   route_flow_contribution_consent   SELECT,INSERT,UPDATE     ALL (8) [ci only]
--   sensing_anon_contributions        SELECT,INSERT,DELETE     ALL (8) [ci only]
--
-- The cause is the same in all eight: the file GRANTs without first REVOKEing,
-- so the default-privilege ALL survives underneath and the enumeration is
-- decorative. The canonical pattern that gets this right is
-- 2217_protected_locations.sql:156-161 — REVOKE from service_role FIRST, then
-- grant back. Three of the four Map migrations follow it and land exactly the
-- privileges they name; 2224 does not, and does not.
--
-- Severity is genuinely lower here than for FINDING 1: service_role is the
-- server's own identity, it is BYPASSRLS by design, and it is never held by a
-- client. This is least-privilege hygiene and the closing of a stated-vs-actual
-- gap, not an exposure. It is fixed in the same file because it has the same
-- cause and the same one-line remedy.
--
-- Two of the eight are CONSENT tables (intel_contribution_consent,
-- route_flow_contribution_consent) holding TRUNCATE. A consent record exists to
-- prove that consent was given or withdrawn; a privilege that erases the whole
-- ledger in one statement is the wrong shape for it. route_flow's own
-- CHECK (enabled = false OR evidence present) exists to preserve exactly that
-- evidence.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY EACH GRANTED SET BELOW IS SAFE — CALL SITES READ, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- Every non-test call site under artifacts/api-server/src was read before
-- narrowing. Nothing below removes a privilege a live path uses.
--
--   memory_events/-_projections/-_feedback: the account-deletion purge does NOT
--     go through service_role grants — AccountDeletionService.ts:1198 calls the
--     SECURITY DEFINER erase_memory_for_user, which runs as its owner. Direct
--     call sites are SELECT (compass.ts:2241,2363) and INSERT (compass.ts:2253,
--     2413,2473; placeIdBridge.ts:313). DELETE stays granted regardless.
--   memory_policy: ZERO non-test call sites in the tree. SELECT only, per 2192.
--   intel_contribution_consent: SELECT (intelConsent.ts:46,69,119 and others)
--     plus DELETE (AccountDeletionService.ts:1139) — 2203 granted that DELETE
--     deliberately, so the set below keeps it.
--   intel_live_promoted_scopes: SELECT only (liveClaimRead.ts:229).
--   route_flow_contribution_consent: SELECT only
--     (mapProjectionTemporal.ts:261).
--   sensing_anon_contributions: INSERT (sensingAnonStore.ts:381) and SELECT
--     (:424). The store is inert by construction; the grant matches 2315.
--
-- The `authenticated` SELECT on the two consent tables is DELIBERATE and is
-- preserved: 2172 and 2224 both grant it so a traveller can read their own
-- consent row under an owner policy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK: db/rollback/2026-09-07-2333-grant-boundary-rollback.sql
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRECONDITION — declared dependency, enforced
-- ═══════════════════════════════════════════════════════════════════════════
-- Without this block the first REVOKE naming an absent table raises the opaque
-- "relation ... does not exist" and rolls back everything, leaving no clue that
-- the cause is a missing PREREQUISITE rather than a typo in this file.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.name || ' (created by ' || t.src || ')', '; ' ORDER BY t.name)
    INTO v_missing
    FROM (VALUES
      ('route_flow_contribution_consent', '2224_route_hop_signal.sql'),
      ('sensing_anon_contributions',      '2315_sensing_anon_contributions.sql')
    ) AS t(name, src)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = t.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '2333 PRECONDITION NOT MET: apply the migration(s) that create these tables first, then re-run 2333 -- %',
      v_missing;
  END IF;
END $$;

-- ─── FINDING 1: revoke the public/authenticated ALL from derived memory ──────
-- These four have zero RLS policies, so nothing legitimate reaches them as anon
-- or authenticated. Nothing is granted back.

REVOKE ALL ON public.memory_events      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_feedback    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_policy      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_projections FROM PUBLIC, anon, authenticated;

-- ─── FINDING 2: make each service_role grant match its migration's intent ────
-- REVOKE-then-GRANT. The granted set is exactly what the originating migration
-- enumerated (plus 2203's DELETE on intel_contribution_consent).

REVOKE ALL ON public.memory_events FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.memory_events TO service_role;

REVOKE ALL ON public.memory_feedback FROM service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_feedback TO service_role;

REVOKE ALL ON public.memory_projections FROM service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_projections TO service_role;

REVOKE ALL ON public.memory_policy FROM service_role;
GRANT SELECT ON public.memory_policy TO service_role;

REVOKE ALL ON public.intel_contribution_consent FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_contribution_consent TO service_role;

REVOKE ALL ON public.intel_live_promoted_scopes FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_live_promoted_scopes TO service_role;

REVOKE ALL ON public.route_flow_contribution_consent FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.route_flow_contribution_consent TO service_role;

REVOKE ALL ON public.sensing_anon_contributions FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.sensing_anon_contributions TO service_role;

-- ─── preserve the deliberate authenticated SELECT on the two consent tables ──
-- Re-granted AFTER the blanket revokes above so ordering cannot drop them.
GRANT SELECT ON public.intel_contribution_consent      TO authenticated;
GRANT SELECT ON public.route_flow_contribution_consent TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- Added 2026-09-07. This file previously had none: it revoked and granted and
-- then reported success whether or not any of it landed. A grant migration is
-- exactly the kind that fails quietly -- a REVOKE against a role that does not
-- hold the privilege is a silent no-op, and so is a GRANT on a table that does
-- not exist under the name you typed. The vacuity guard below exists because
-- the first applied-state probe written for THIS migration checked a table
-- called `memory_moments`, which does not exist in either database, and
-- therefore reported "anon has been revoked" for a table that was never there.
DO $$
DECLARE
  r          record;
  v_missing  text;
  v_actual   text;
  v_leak     text;
BEGIN
  -- VACUITY GUARD: every table this migration claims to govern must exist.
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO v_missing
    FROM (VALUES
      ('memory_events'), ('memory_feedback'), ('memory_policy'),
      ('memory_projections'), ('intel_contribution_consent'),
      ('intel_live_promoted_scopes'), ('route_flow_contribution_consent'),
      ('sensing_anon_contributions')
    ) AS t(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = t.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '2333 postcondition VACUOUS: these tables do not exist, so the statements naming them did nothing: %',
      v_missing;
  END IF;

  -- 1. FINDING 1: anon and authenticated hold NOTHING on the four derived
  --    memory tables. Nothing was granted back to them, so the set must be empty.
  SELECT string_agg(DISTINCT c.relname || '/' || rr.rolname || '/' || x.privilege_type, ', ')
    INTO v_leak
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) x
    JOIN pg_roles rr ON rr.oid = x.grantee
   WHERE n.nspname = 'public'
     AND c.relname IN ('memory_events','memory_feedback','memory_policy','memory_projections')
     AND rr.rolname IN ('anon','authenticated');

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION
      '2333 postcondition FAILED: anon/authenticated still hold privileges on derived memory tables: %',
      v_leak;
  END IF;

  -- 2. FINDING 2: service_role holds EXACTLY the set each originating migration
  --    enumerated -- no more (the point of the file) and no less (a narrowing
  --    that removed a privilege a live path uses would be an outage).
  FOR r IN
    SELECT * FROM (VALUES
      ('memory_events',                   'DELETE,INSERT,SELECT'),
      ('memory_feedback',                 'DELETE,INSERT,SELECT,UPDATE'),
      ('memory_projections',              'DELETE,INSERT,SELECT,UPDATE'),
      ('memory_policy',                   'SELECT'),
      ('intel_contribution_consent',      'DELETE,INSERT,SELECT,UPDATE'),
      ('intel_live_promoted_scopes',      'DELETE,INSERT,SELECT,UPDATE'),
      ('route_flow_contribution_consent', 'INSERT,SELECT,UPDATE'),
      ('sensing_anon_contributions',      'DELETE,INSERT,SELECT')
    ) AS t(tbl, expected)
  LOOP
    SELECT coalesce(string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type), '(none)')
      INTO v_actual
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
      JOIN pg_roles rr ON rr.oid = x.grantee
     WHERE n.nspname = 'public' AND c.relname = r.tbl AND rr.rolname = 'service_role';

    IF v_actual IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION
        '2333 postcondition FAILED on %: service_role holds [%] but this migration grants [%]',
        r.tbl, v_actual, r.expected;
    END IF;
  END LOOP;

  -- 3. The deliberate authenticated SELECT on the two consent tables survived
  --    the blanket revokes. A traveller must still be able to read their own
  --    consent row under its owner policy (2172, 2224).
  FOR r IN
    SELECT * FROM (VALUES
      ('intel_contribution_consent'), ('route_flow_contribution_consent')
    ) AS t(tbl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) x
        JOIN pg_roles rr ON rr.oid = x.grantee
       WHERE n.nspname = 'public' AND c.relname = r.tbl
         AND rr.rolname = 'authenticated' AND x.privilege_type = 'SELECT'
    ) THEN
      RAISE EXCEPTION
        '2333 postcondition FAILED: authenticated lost SELECT on %, which 2172/2224 grant deliberately so a traveller can read their own consent row.',
        r.tbl;
    END IF;
  END LOOP;

  RAISE NOTICE '2333 OK: 8 tables verified, anon/authenticated cleared from the four derived memory tables, service_role narrowed to the enumerated sets, consent SELECT preserved.';
END $$;

COMMIT;
