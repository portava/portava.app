-- 3653_availability_client_reads_withheld.sql
-- Lead ruling P-T1 (2026-10-07) on the DIRECT PostgREST door — census-telegraph T29 / T421.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T band 3650-3669.
--
-- P-T1, verbatim: "invisible mode hides availability from everyone incl. crew".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS STILL OPEN
-- ══════════════════════════════════════════════════════════════════════════════
-- Every API door that shows another person's availability now asks the
-- invisibility read first (services/telegraph/availabilityInvisibility.ts, census-
-- telegraph §51, §52, §62). The DATABASE door did not: the baseline grants anon and
-- authenticated ALL on both tables below, and six SELECT policies admit a friend,
-- a circle member or a trip-mate to a person's rows —
--
--   user_availability          ua_friends_select, ua_circle_select, ua_trip_select
--                              (weekly_days, open_to_meet, strict_mode)
--   quick_availability_status  qas_friends_select, qas_circle_select, qas_trip_select
--                              (status 'free_now' / 'free_tonight' / …, expires_at)
--
-- No policy can ask "is the owner invisible?" without a definer predicate over
-- another person's location_preferences, so with the public key and their own
-- session a crew-mate read an invisible person's weekly grid, "open to meet" and
-- live "free now" status straight from PostgREST — exactly what P-T1 withholds on
-- every API surface.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKEs every client privilege on both tables (PUBLIC, anon, authenticated) —
-- the G-1 shape (lead rulings 2026-10-07: "revoke client roles on the tables no
-- client path uses"). No client path uses them: the app reads and writes its own
-- grid and status through /api/me/availability and /api/me/quick-availability, and
-- every server reader runs on the service client (requireUser's `client` IS the
-- service client; lead ruling L205), where the P-T1 read is applied. The proof
-- that no client tree names either table is a test
-- (src/test/telegraphAvailabilityClientDoor.test.ts), so the day one does it fails
-- there instead of on a 42501 in production.
--
-- Policies are left in place and become inert for client roles (they narrow a
-- privilege nobody holds) — the same end state as 3740 part 1. Rows, service_role
-- and RLS are untouched.
--
-- profiles.open_to_meet (lead ruling P-T1a) is the same door on a third table;
-- it is closed by 3762, which must sort after 3740 (3740 re-grants the baseline's
-- profiles column list, open_to_meet included).
--
-- ROLLBACK: db/rollback/2026-10-08-3653-availability-client-reads-withheld-rollback.sql
-- (re-opens the door: it re-grants SELECT, INSERT, UPDATE, DELETE to both roles).

BEGIN;

DO $pre$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_availability', 'quick_availability_status'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3653): public.% does not exist.', t;
    END IF;
    -- RLS decides which ROWS the service path is never asked about; with it off
    -- the table was never in the state this file describes.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3653): RLS is not enabled on public.%. Refusing.', t;
    END IF;
  END LOOP;
END $pre$;

REVOKE ALL ON TABLE public.user_availability FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.quick_availability_status FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions — assertion-only, re-runnable after COMMIT, catalog only ────
DO $post$
DECLARE
  t text;
  r text;
  p text;
  v_names text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_availability', 'quick_availability_status'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3653): public.% does not exist.', t;
    END IF;
    -- 1. No client role holds any privilege on the table, at table OR column
    --    level, directly or through PUBLIC (has_*_privilege resolves both).
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'POSTCONDITION FAILED (3653): % still holds % on public.% (table or column level).', r, p, t;
        END IF;
      END LOOP;
      FOREACH p IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'POSTCONDITION FAILED (3653): % still holds % on public.%.', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    -- 2. No ACL entry for PUBLIC or a client role survives anywhere on the table.
    SELECT string_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END || ':' || x.privilege_type, ', ')
      INTO v_names
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.oid = ('public.' || t)::regclass
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3653): public.% still grants %.', t, v_names;
    END IF;
    SELECT string_agg(DISTINCT a.attname || ':' || x.privilege_type, ', ')
      INTO v_names
      FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = ('public.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3653): public.% still grants column privilege(s) %.', t, v_names;
    END IF;
    -- 3. The server is untouched: every reader and writer runs as service_role.
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.' || t, p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3653): service_role lost % on public.%.', p, t;
      END IF;
    END LOOP;
    -- 4. RLS stays on.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3653): RLS is not enabled on public.%.', t;
    END IF;
  END LOOP;
END $post$;
