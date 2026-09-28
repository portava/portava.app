-- 3390_discovery_rls_explicit_policies.sql
-- Discovery database lane (census-discovery DV-71, §54): `10` §5 — "Every
-- user-visible table must explicitly define: read policy, insert policy,
-- update policy, delete policy … Do not rely only on API filtering."
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery database
-- and rollout lane 3390-3394). APPLIED TO NO SHARED DATABASE by the lane that
-- wrote it: applied, rolled back and re-applied on the local PostgreSQL 16
-- harness only (scripts/local-db). NOT applied to portava-ci, NOT applied to
-- production.
--
-- Policies and privileges only. Creates no table, no index, no function, writes
-- no row, flips no flag, and DROPS NO EXISTING POLICY. Idempotent: every policy
-- it creates replaces a policy of the same name (its own, on a re-run), and REVOKE of
-- an absent privilege is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- A production catalogue read on 2026-09-13 (census-discovery DV-71) found RLS
-- ENABLED on all seven `discovery*` tables, `discovery_place_photos` with ZERO
-- policies, five tables with two each, and only `discovery_places` with all
-- four operations spelled. Fail-closed, so under-specification rather than a
-- leak: an operation with no permissive policy is denied. But "denied because
-- nobody wrote anything" and "denied because somebody decided so" read the same
-- in the catalogue, and `10` §5 asks for the second.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE TABLES, RE-DERIVED FROM THE MIGRATIONS (not copied from the census)
-- ══════════════════════════════════════════════════════════════════════════════
-- Every table in the exposed `public` schema that a Discovery migration creates,
-- plus `rank_events`, which `10` §3 names as Discovery's behaviour table. A
-- table in `public` is reachable by PostgREST under the anon key whenever a
-- client role holds a privilege on it, so every one of them is user-visible at
-- the API layer whether or not a screen reads it.
--
--   discovery_places         0029 (+2153 client write boundary)
--   discovery_place_saves    baseline (production structure, 2026-08-19)
--   discovery_place_reports  0061
--   discovery_cache          0168
--   discovery_geocode_cache  0168
--   discovery_shadow_serves  2092 / 2093
--   discovery_place_photos   2095
--   place_momentum           2892   (absent from production: skipped there)
--   trails                   2910
--   content_trails           2910
--   trail_edges              2910
--   trail_follows            2910
--   trail_reports            2910
--   trail_health_snapshots   2910
--   recommendations          3376   (absent from production: skipped there)
--   rank_events              0153   (shared with Pulse, Wall and the media feed)
--
-- DELIBERATELY NOT HERE, each with its reason:
--   creator_attributions, creator_rule_versions, creator_earning_entries
--     (2920/2921) — the creator ledger, owned and being reshaped by the ledger
--     lane (census-discovery §52). Same state as place_momentum today (RLS on,
--     zero policies, no client grant); the identical pattern is offered to that
--     lane rather than written into its tables from here.
--   compass_* and layover_recommendations — Compass's and Layover's surfaces.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT A CLIENT ROLE MAY DO — PRESERVED EXACTLY, NOTHING GAINED
-- ══════════════════════════════════════════════════════════════════════════════
-- Measured before writing this (repo-wide grep, 2026-09-27): no client in this
-- repository reaches any of these tables through PostgREST. The travel-buddy
-- client's only `.from(...)` targets are profiles, message threads, follows,
-- trips, trip members, event RSVPs, circles and two Rent-a-Buddy tables; no
-- realtime channel subscribes to one of them; no view selects from one; and
-- every server read and write goes through getServiceClient() (service_role,
-- BYPASSRLS on Supabase and in the harness shim). So:
--
--   * Every EXISTING permissive client policy is KEPT, unmodified, as the
--     explicit definition of that operation — a designed row rule nobody uses
--     is still a designed row rule, and dropping it is not this file's call:
--       discovery_places         SELECT  anon+authenticated  status = 'active'
--       discovery_place_saves    SELECT, INSERT  authenticated  own row
--       discovery_place_reports  SELECT, INSERT  authenticated  own row
--       rank_events              SELECT  authenticated  own row
--       trails                   SELECT  authenticated  not archived
--       content_trails, trail_edges  SELECT  authenticated  all
--       trail_follows            SELECT  authenticated  own row
--   * EVERY OTHER (table, operation, client role) gets an explicit RESTRICTIVE
--     policy `USING (false)` / `WITH CHECK (false)` named
--     <table>_deny_<op>_<clients|anon>, AND the matching table privilege is
--     revoked from that role. A restrictive false policy denies whatever
--     permissive policy exists or is added later, so the boundary no longer
--     rests on a grant alone — it is the census's §6 D6 hazard ("one re-GRANT
--     from a column-unconstrained forge") closed WITHOUT dropping the four
--     decorative discovery_places write policies, which stays D6's decision.
--   * TRUNCATE, REFERENCES and TRIGGER are revoked from anon and authenticated
--     on every table above. RLS does not police them (2490's argument, applied
--     here without MAINTAIN so the file replays on PostgreSQL 16 as well as 17).
--     PostgREST exposes no TRUNCATE verb, so no client path loses anything.
--   * EXECUTE on public.rebuild_place_momentum(timestamptz) and
--     public.place_momentum_classify(...) is revoked from anon and
--     authenticated. 2892 revoked FROM PUBLIC and granted service_role, but
--     Supabase's default privileges had ALREADY granted EXECUTE to anon and
--     authenticated at CREATE time (measured on the harness: both true), and
--     REVOKE ... FROM PUBLIC does not touch a role-specific grant. The rebuild
--     is SECURITY INVOKER, so a client call fails on place_momentum's grants
--     today — the revoke removes the path rather than relying on that.
--
-- service_role is NOT touched: no policy below names it, no privilege of it is
-- revoked, and the postconditions assert its table privileges are identical
-- before and after.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — cardinality, index rationale, EXPLAIN
-- ══════════════════════════════════════════════════════════════════════════════
-- No index and no query path. A RESTRICTIVE `false` policy adds a constant
-- qual to client-role plans only; service_role (BYPASSRLS) plans are unchanged.
--
-- Rollback: db/rollback/2026-09-27-3390-discovery-rls-explicit-policies-rollback.sql
-- (drops the policies this file created, and re-grants exactly the DML
-- privileges the chain had granted and this file revoked — never TRUNCATE).

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3390): auth.uid() does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3390): the anon / authenticated / service_role roles are not all present.';
  END IF;
  -- The four tables every Discovery serve reads must exist; the rest are
  -- optional (2892 and 3376 are absent from production) and are skipped.
  IF to_regclass('public.discovery_places') IS NULL OR to_regclass('public.rank_events') IS NULL
     OR to_regclass('public.discovery_place_saves') IS NULL OR to_regclass('public.discovery_cache') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3390): a core Discovery table (discovery_places, rank_events, discovery_place_saves, discovery_cache) is missing.';
  END IF;
  -- Every client path this file KEEPS must be a policy that exists today; if a
  -- database lacks one, this file would be writing a posture it did not read.
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace
         AND (c.relname, p.polname) IN (
           ('discovery_places', 'discovery_places_public_read'),
           ('discovery_place_saves', 'Users read own saves'),
           ('discovery_place_saves', 'Users insert own saves'),
           ('rank_events', 'users_read_own_rank_events'))) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3390): a client policy this migration preserves is missing; re-derive the posture before applying.';
  END IF;
END $pre$;

-- The DECLARED posture: the client paths that stay. Anything not listed here is
-- denied, explicitly, to that role. `keeps` names the permissive policy that
-- defines the kept path, so the postcondition can check it still exists.
CREATE TEMP TABLE _p3390_tables (tbl text PRIMARY KEY, reason text NOT NULL) ON COMMIT DROP;
INSERT INTO _p3390_tables (tbl, reason) VALUES
  ('discovery_places',        'public catalogue of active places; written only by the server (2153)'),
  ('discovery_place_saves',   'a user''s own saves; the server writes them through the service role'),
  ('discovery_place_reports', 'a user''s own reports; the server writes them through the service role'),
  ('discovery_cache',         'server L2 cache of Overpass payloads; no client reads it'),
  ('discovery_geocode_cache', 'server geocode cache; no client reads it'),
  ('discovery_shadow_serves', 'append-only shadow comparison log (2092); service role only'),
  ('discovery_place_photos',  'server photo cache (2095); service role only'),
  ('place_momentum',          'derived behavioural aggregate (2892); service role only'),
  ('trails',                  'public Trail objects; written only by the server'),
  ('content_trails',          'public Trail membership; written only by the server'),
  ('trail_edges',             'public Trail relations; written only by the server'),
  ('trail_follows',           'a user''s own follows; written only by the server'),
  ('trail_reports',           'moderation reports on Trails; service role only'),
  ('trail_health_snapshots',  'derived Trail health (2910); service role only'),
  ('recommendations',         'per-request serve record (3376); service role only'),
  ('rank_events',             'behaviour events; a user may read their own, the server writes them');

CREATE TEMP TABLE _p3390_keep (tbl text NOT NULL, op text NOT NULL, role text NOT NULL, keeps text NOT NULL) ON COMMIT DROP;
INSERT INTO _p3390_keep (tbl, op, role, keeps) VALUES
  ('discovery_places',        'SELECT', 'anon',          'discovery_places_public_read'),
  ('discovery_places',        'SELECT', 'authenticated', 'discovery_places_public_read'),
  ('discovery_place_saves',   'SELECT', 'authenticated', 'Users read own saves'),
  ('discovery_place_saves',   'INSERT', 'authenticated', 'Users insert own saves'),
  ('discovery_place_reports', 'SELECT', 'authenticated', 'auth_select_own_report'),
  ('discovery_place_reports', 'INSERT', 'authenticated', 'auth_insert_own_report'),
  ('trails',                  'SELECT', 'authenticated', 'trails_public_select'),
  ('content_trails',          'SELECT', 'authenticated', 'content_trails_public_select'),
  ('trail_edges',             'SELECT', 'authenticated', 'trail_edges_public_select'),
  ('trail_follows',           'SELECT', 'authenticated', 'trail_follows_own_select'),
  ('rank_events',             'SELECT', 'authenticated', 'users_read_own_rank_events');

-- service_role's privileges BEFORE, per present table, for the postcondition.
CREATE TEMP TABLE _p3390_svc_before ON COMMIT DROP AS
  SELECT t.tbl,
         (SELECT string_agg(g.privilege_type, ',' ORDER BY g.privilege_type)
            FROM information_schema.role_table_grants g
           WHERE g.table_schema = 'public' AND g.table_name = t.tbl AND g.grantee = 'service_role') AS privs
    FROM _p3390_tables t
   WHERE to_regclass('public.' || t.tbl) IS NOT NULL;

DO $apply$
DECLARE
  t record;
  v_op text;
  denied text[];
  pname text;
  who text;
  skipped text[] := ARRAY[]::text[];
BEGIN
  FOR t IN SELECT tbl, reason FROM _p3390_tables ORDER BY tbl LOOP
    IF to_regclass('public.' || t.tbl) IS NULL THEN
      skipped := skipped || t.tbl;
      CONTINUE;
    END IF;
    -- RLS must be on before a policy means anything. Every table above already
    -- has it on; this makes the file correct on a database where one does not.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);

    FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      SELECT array_agg(r ORDER BY r) INTO denied
        FROM unnest(ARRAY['anon','authenticated']) r
       WHERE NOT EXISTS (SELECT 1 FROM _p3390_keep k WHERE k.tbl = t.tbl AND k.op = v_op AND k.role = r);
      IF denied IS NULL THEN CONTINUE; END IF;

      who   := CASE WHEN array_length(denied, 1) = 2 THEN 'clients' ELSE denied[1] END;
      pname := format('%s_deny_%s_%s', t.tbl, lower(v_op), who);
      IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public.' || t.tbl) AND polname = pname) THEN
        EXECUTE format('DROP POLICY %I ON public.%I', pname, t.tbl);  -- re-run: replace our own policy
      END IF;
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR %s TO %s %s',
        pname, t.tbl, v_op,
        (SELECT string_agg(quote_ident(r), ', ') FROM unnest(denied) r),
        CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
      EXECUTE format(
        'COMMENT ON POLICY %I ON public.%I IS %L',
        pname, t.tbl,
        format('3390 (census-discovery DV-71, `10` §5): %s is DENIED to %s on %s — %s. Explicit and restrictive, so a later permissive policy or re-GRANT cannot reopen it silently. The server path is service_role (BYPASSRLS) and is not affected.',
               v_op, array_to_string(denied, ' and '), t.tbl, t.reason));
      EXECUTE format('REVOKE %s ON public.%I FROM %s', v_op, t.tbl,
                     (SELECT string_agg(quote_ident(r), ', ') FROM unnest(denied) r));
    END LOOP;

    -- Not policed by RLS at all (2490's argument). No client path uses any.
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t.tbl);
  END LOOP;

  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM anon, authenticated;
  END IF;
  IF to_regprocedure('public.place_momentum_classify(double precision,double precision,double precision,double precision)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.place_momentum_classify(double precision, double precision, double precision, double precision) FROM anon, authenticated;
  END IF;

  IF array_length(skipped, 1) > 0 THEN
    RAISE NOTICE '3390: skipped absent table(s): % — re-run after they are applied.', array_to_string(skipped, ', ');
  END IF;
END $apply$;

-- ── Postconditions (inside the transaction, so a failure rolls all of it back) ─
-- This block reads the real catalogue only, so certify:migrations can re-run it
-- after COMMIT, when the ON COMMIT DROP tables above are gone. The declared
-- posture is restated as literals; in the applying transaction they are checked
-- against those tables, and service_role against its BEFORE snapshot.
DO $post$
DECLARE
  t record;
  v_op text;
  v_role text;
  holds boolean;
  permissive_for_role boolean;
  deny_for_role boolean;
  n int;
  bad text[] := ARRAY[]::text[];
  tbls text[] := ARRAY['discovery_places', 'discovery_place_saves', 'discovery_place_reports',
    'discovery_cache', 'discovery_geocode_cache', 'discovery_shadow_serves', 'discovery_place_photos',
    'place_momentum', 'trails', 'content_trails', 'trail_edges', 'trail_follows', 'trail_reports',
    'trail_health_snapshots', 'recommendations', 'rank_events'];
  keep text[] := ARRAY['discovery_places|SELECT|anon', 'discovery_places|SELECT|authenticated',
    'discovery_place_saves|SELECT|authenticated', 'discovery_place_saves|INSERT|authenticated',
    'discovery_place_reports|SELECT|authenticated', 'discovery_place_reports|INSERT|authenticated',
    'trails|SELECT|authenticated', 'content_trails|SELECT|authenticated',
    'trail_edges|SELECT|authenticated', 'trail_follows|SELECT|authenticated',
    'rank_events|SELECT|authenticated'];
BEGIN
  IF to_regclass('pg_temp._p3390_tables') IS NOT NULL THEN
    -- The applying transaction: the literals must be the declared posture.
    IF (SELECT array_agg(x ORDER BY x) FROM unnest(tbls) x)
         IS DISTINCT FROM (SELECT array_agg(d.tbl ORDER BY d.tbl) FROM _p3390_tables d)
       OR (SELECT array_agg(x ORDER BY x) FROM unnest(keep) x)
         IS DISTINCT FROM (SELECT array_agg(k.s ORDER BY k.s)
                             FROM (SELECT format('%s|%s|%s', tbl, op, role) AS s FROM _p3390_keep) k) THEN
      bad := bad || 'the postcondition''s table or kept-path literals differ from _p3390_tables / _p3390_keep'::text;
    END IF;
    -- service_role privileges unchanged, table by table (its BEFORE snapshot exists only here).
    SELECT count(*) INTO n FROM _p3390_svc_before b
     WHERE b.privs IS DISTINCT FROM (SELECT string_agg(g.privilege_type, ',' ORDER BY g.privilege_type)
                                       FROM information_schema.role_table_grants g
                                      WHERE g.table_schema = 'public' AND g.table_name = b.tbl AND g.grantee = 'service_role');
    IF n > 0 THEN bad := bad || format('%s table(s) changed service_role privileges', n); END IF;
  END IF;

  FOR t IN SELECT u.tbl FROM unnest(tbls) AS u(tbl) WHERE to_regclass('public.' || u.tbl) IS NOT NULL ORDER BY u.tbl LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t.tbl)) THEN
      bad := bad || format('%s: RLS disabled', t.tbl);
    END IF;
    FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      -- Explicitness: at least one policy that names this operation for a
      -- client role (or PUBLIC). An ALL policy scoped to service_role does not
      -- count — it says nothing about what a client may do.
      SELECT count(*) INTO n FROM pg_policy p
       WHERE p.polrelid = to_regclass('public.' || t.tbl)
         AND p.polcmd = CASE v_op WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END
         AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM pg_roles ro WHERE ro.oid = ANY (p.polroles) AND ro.rolname IN ('anon','authenticated')));
      IF n = 0 THEN bad := bad || format('%s %s: no policy names this operation for a client role', t.tbl, v_op); END IF;

      FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
        holds := has_table_privilege(v_role, 'public.' || t.tbl, v_op);
        SELECT EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = to_regclass('public.' || t.tbl) AND p.polpermissive
                          AND p.polcmd IN ('*', CASE v_op WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)
                          AND (0 = ANY (p.polroles) OR (SELECT oid FROM pg_roles WHERE rolname = v_role) = ANY (p.polroles)))
          INTO permissive_for_role;
        SELECT EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = to_regclass('public.' || t.tbl) AND NOT p.polpermissive
                          AND p.polcmd = CASE v_op WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END
                          AND (SELECT oid FROM pg_roles WHERE rolname = v_role) = ANY (p.polroles))
          INTO deny_for_role;
        IF format('%s|%s|%s', t.tbl, v_op, v_role) = ANY (keep) THEN
          IF deny_for_role THEN bad := bad || format('%s %s %s: a kept client path is denied', t.tbl, v_op, v_role); END IF;
          IF NOT permissive_for_role THEN bad := bad || format('%s %s %s: the kept permissive policy is gone', t.tbl, v_op, v_role); END IF;
        ELSE
          IF NOT deny_for_role THEN bad := bad || format('%s %s %s: no explicit restrictive deny', t.tbl, v_op, v_role); END IF;
          IF holds THEN bad := bad || format('%s %s %s: privilege still held', t.tbl, v_op, v_role); END IF;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_op IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF has_table_privilege(v_role, 'public.' || t.tbl, v_op) THEN bad := bad || format('%s %s %s: still held', t.tbl, v_op, v_role); END IF;
      END LOOP;
    END LOOP;
    -- No policy this file created may name service_role.
    IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = to_regclass('public.' || t.tbl)
                AND p.polname LIKE t.tbl || '_deny_%'
                AND (SELECT oid FROM pg_roles WHERE rolname = 'service_role') = ANY (p.polroles)) THEN
      bad := bad || format('%s: a 3390 deny policy names service_role', t.tbl);
    END IF;
  END LOOP;

  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NOT NULL
     AND (has_function_privilege('anon', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE')
          OR has_function_privilege('authenticated', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE')) THEN
    bad := bad || 'rebuild_place_momentum is still executable by a client role'::text;
  END IF;

  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3390): %', array_to_string(bad, '; ');
  END IF;
  RAISE NOTICE '3390 OK: every present Discovery table defines SELECT/INSERT/UPDATE/DELETE for anon and authenticated explicitly; kept client paths intact; service_role unchanged.';
END $post$;

COMMIT;
