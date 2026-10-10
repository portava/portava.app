-- 3620_layover_client_write_boundary.sql
-- census-layover L200 ("users may read/write their own session inputs WITHIN
-- ALLOWED FIELDS") and L199 ("postconditions + authorization-contract
-- coverage"); owner decision L199-b, which applying this file IS.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane R band 3620-3639).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
-- 0127 created layover_sessions, layover_plan_stops, layover_events and
-- airport_profiles under an ALTER DEFAULT PRIVILEGES that handed `anon` and
-- `authenticated` DELETE, INSERT, SELECT and UPDATE on every one of them
-- (measured on portava-ci 2026-09-07; 2335 section 2 took TRUNCATE back).
-- The owner policy on layover_sessions is FOR ALL with a WITH CHECK on
-- user_id, so it is ownership-correct and COLUMN-BLIND: a traveller holding
-- their own JWT can PATCH their session's `status`, `return_reminder_at` and
-- `share_city_status` straight through PostgREST, around every rule the
-- routes apply (census L200). layover_plan_stops has the same FOR ALL shape.
-- layover_events and airport_profiles are protected only because their one
-- policy is SELECT; the grant underneath is still the full DML set.
--
-- No application path writes any of the four as a user. Every writer is the
-- service role: routes/airport.ts through getServiceClient, the layover
-- services through an injected service client, the airport admin routes.
-- The mobile client reads and writes them only through the API. So the
-- client roles need SELECT (authenticated, owner-scoped by RLS) and nothing
-- else.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
--   authenticated  SELECT only, on all four. RLS still scopes the rows
--                  (owner-only on sessions/stops/events; airport_profiles is
--                  readable to any signed-in user, as before).
--   anon           nothing. No anon policy exists on any of the four, so RLS
--                  already returned it no rows; the grant goes too.
--   service_role   unchanged: SELECT, INSERT, UPDATE, DELETE.
-- Column-level grants, if any were ever made, are revoked with the table
-- grants, so has_any_column_privilege cannot reopen a write.
-- The policies are NOT changed: with no write grant underneath, the FOR ALL
-- policies' write branches are unreachable, and leaving them keeps this file
-- to one kind of change. authorization-contract.json's four entries shrink
-- to this state in the same PR, as its `$pinnedAsMeasured` note requires.
--
-- No flag: this narrows a database boundary no application code relies on.
-- DEPENDS ON: 0127, 2335 (TRUNCATE already revoked; asserted again below).
-- Rollback: db/rollback/2026-10-07-3620-layover-client-write-boundary-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL
     OR to_regclass('public.layover_plan_stops') IS NULL
     OR to_regclass('public.layover_events') IS NULL
     OR to_regclass('public.airport_profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3620): a 0127 layover table is missing -- apply 0127 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3620): role service_role does not exist; every writer of these tables runs as it.';
  END IF;
END $pre$;

REVOKE ALL ON TABLE public.layover_sessions   FROM anon;
REVOKE ALL ON TABLE public.layover_plan_stops FROM anon;
REVOKE ALL ON TABLE public.layover_events     FROM anon;
REVOKE ALL ON TABLE public.airport_profiles   FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.layover_sessions   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.layover_plan_stops FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.layover_events     FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.airport_profiles   FROM authenticated;

GRANT SELECT ON TABLE public.layover_sessions   TO authenticated;
GRANT SELECT ON TABLE public.layover_plan_stops TO authenticated;
GRANT SELECT ON TABLE public.layover_events     TO authenticated;
GRANT SELECT ON TABLE public.airport_profiles   TO authenticated;

-- Column-level grants: revoke every one the client roles hold on these four.
-- A table-level REVOKE does not remove a privilege granted on a column.
DO $cols$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT DISTINCT c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('layover_sessions', 'layover_plan_stops', 'layover_events', 'airport_profiles')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attacl IS NOT NULL
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.%I FROM anon, authenticated', rec.col, rec.tbl);
  END LOOP;
END $cols$;

-- PG17 adds MAINTAIN; revoke it where the server has it.
DO $maintain$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE public.layover_sessions, public.layover_plan_stops, public.layover_events, public.airport_profiles FROM anon, authenticated';
  END IF;
END $maintain$;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $post$
DECLARE
  t TEXT;
  v TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['layover_sessions', 'layover_plan_stops', 'layover_events', 'airport_profiles'] LOOP
    IF (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = t) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3620): RLS is not enabled on %', t;
    END IF;

    IF NOT has_table_privilege('authenticated', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3620): authenticated lost SELECT on % -- the owner reads would break', t;
    END IF;
    FOREACH v IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('authenticated', format('public.%I', t), v) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3620): authenticated still holds % on % -- a traveller can write it through PostgREST', v, t;
      END IF;
    END LOOP;
    FOREACH v IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege('authenticated', format('public.%I', t), v) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3620): authenticated holds column-level % on % -- the column grant reopens the write the table grant closed', v, t;
      END IF;
    END LOOP;

    -- has_table_privilege('anon', ...) folds in PUBLIC grants as well.
    FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('anon', format('public.%I', t), v) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3620): anon holds % on % -- the unauthenticated role is granted nothing here', v, t;
      END IF;
    END LOOP;
    IF has_any_column_privilege('anon', format('public.%I', t), 'SELECT')
       OR has_any_column_privilege('anon', format('public.%I', t), 'INSERT')
       OR has_any_column_privilege('anon', format('public.%I', t), 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3620): anon holds a column-level privilege on %', t;
    END IF;

    FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', format('public.%I', t), v) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3620): service_role lacks % on % -- the only writer would fail', v, t;
      END IF;
    END LOOP;
  END LOOP;

  -- The owner policies are untouched, and still scope the one verb left.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layover_sessions' AND policyname = 'layover_sessions_owner') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3620): policy layover_sessions_owner is absent -- authenticated SELECT would read no rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'airport_profiles' AND policyname = 'airport_profiles_read') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3620): policy airport_profiles_read is absent -- airport search would read no rows';
  END IF;
END $post$;

COMMIT;
