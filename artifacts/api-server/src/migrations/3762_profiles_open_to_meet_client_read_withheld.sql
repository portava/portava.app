-- 3762_profiles_open_to_meet_client_read_withheld.sql
-- Lead ruling P-T1a (2026-10-08) on the DIRECT PostgREST door — census-telegraph T29 / T421.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T (mission 4).
--
-- WHY THIS NUMBER, OUTSIDE LANE T's BAND (3650-3669). This file narrows the
-- client column ACL of public.profiles. 3740 (lane G, merged) REVOKEs both client
-- roles' SELECT/UPDATE on profiles and re-GRANTs the baseline's column list —
-- open_to_meet included. A file numbered inside 3650-3669 sorts BEFORE 3740, so
-- on every chain replay (the local-db harness, a beta bootstrap, certify) and in
-- every pending-apply order 3740 would grant the column straight back. It has to
-- sort after 3740 (and after 3742, lane G3's narrowing of the same table). 3760
-- and 3761 are Telegraph's (#628); 3762 is unused on origin/main and on every
-- origin branch (checked 2026-10-08). The lead may renumber it: the only
-- constraint is "after 3740".
--
-- P-T1a, verbatim: "profiles.open_to_meet is availability under P-T1 — withheld
-- for an invisible owner on every non-self door (Travel DNA, GET /users/:userId
-- incl. anonymous, profile previews); unreadable ⇒ withheld."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS STILL OPEN
-- ══════════════════════════════════════════════════════════════════════════════
-- The API doors named in P-T1a ask the invisibility read (census-telegraph §62).
-- PostgREST does not: the baseline (and 3740 after it) grants anon AND
-- authenticated column SELECT on profiles.open_to_meet, and profiles_select
-- admits every non-private profile to both roles (2033). So
--   GET /rest/v1/profiles?select=id,handle,open_to_meet
-- with only the public anon key listed every non-private person's "open to meet"
-- — an invisible owner's included. A row policy cannot withhold one column for
-- some owners, so the column grant is the only boundary there is.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKE SELECT (open_to_meet) from PUBLIC, anon and authenticated. Nothing else:
-- UPDATE (open_to_meet) stays (a person may still set their own; the API writes
-- it on the service client anyway), every other column grant is untouched, and
-- no row changes. No client tree selects the column (the app reads its own
-- profile through GET /api/me/profile, on the service client), which a test pins
-- (src/test/telegraphAvailabilityClientDoor.test.ts) so a new direct reader fails
-- there rather than on a 42501 in production.
--
-- 3740's postcondition pins its SELECT list as an upper bound plus the columns
-- the app reads (open_to_meet is not one), so it stays green after this file —
-- the same reading 3742 relies on for UPDATE.
--
-- ROLLBACK: db/rollback/2026-10-08-3762-profiles-open-to-meet-client-read-withheld-rollback.sql
-- (re-opens the door: it re-grants SELECT (open_to_meet) to anon and authenticated).

BEGIN;

DO $pre$
DECLARE
  v_names text;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3762): public.profiles does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.profiles'::regclass AND attname = 'open_to_meet'
                    AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3762): public.profiles has no open_to_meet column.';
  END IF;
  -- A table-level SELECT covers every column and survives a column REVOKE; that
  -- is the replayed-baseline state 3740 removes. Refuse rather than report a
  -- narrowing that did not happen.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, ', ')
    INTO v_names
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.profiles'::regclass AND x.privilege_type = 'SELECT'
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3762): % hold(s) TABLE-level SELECT on public.profiles; a column REVOKE cannot narrow it. Apply 3740 first.', v_names;
  END IF;
END $pre$;

REVOKE SELECT (open_to_meet) ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions — assertion-only, re-runnable after COMMIT, catalog only ────
DO $post$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- 1. The column: no SELECT through any path (table, column or PUBLIC).
    IF has_column_privilege(r, 'public.profiles', 'open_to_meet', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3762): % can still SELECT public.profiles.open_to_meet.', r;
    END IF;
    -- 2. Anti-vacuity: the table is still readable by the role (the narrowing is
    --    one column, not the whole table), through the column every reader uses.
    IF NOT has_column_privilege(r, 'public.profiles', 'id', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3762): % lost SELECT on public.profiles.id; this file narrows one column only.', r;
    END IF;
  END LOOP;
  -- 3. The server is untouched.
  IF NOT has_column_privilege('service_role', 'public.profiles', 'open_to_meet', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3762): service_role cannot SELECT public.profiles.open_to_meet.';
  END IF;
END $post$;
