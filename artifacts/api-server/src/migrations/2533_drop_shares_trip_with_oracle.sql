-- 2533_drop_shares_trip_with_oracle.sql
--
-- public.shares_trip_with(uuid) is dropped. It was a membership oracle of
-- exactly the class 2182 closed, and nothing calls it.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2533 (B5).
-- Follows 2182's header conventions. Read 2182 first.
--
-- Function-only: drops one function. Touches no table, column, policy, grant
-- on a table, or row. Idempotent (DROP FUNCTION IF EXISTS).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT WAS
-- ══════════════════════════════════════════════════════════════════════════════
-- Verbatim from pg_proc on portava-ci and production (md5 of pg_get_functiondef
-- 78d48831b681063352f8cb2ce8dd71d6 on both), 2026-09-07:
--
--   CREATE FUNCTION public.shares_trip_with(other uuid) RETURNS boolean
--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_catalog'
--   AS $$ select exists (select 1 from trip_members me
--                         join trip_members them on them.trip_id = me.trip_id
--                        where me.user_id = auth.uid() and them.user_id = other) $$;
--
-- Three facts make it an oracle rather than a helper:
--
--   1. It lives in `public`, which PostgREST exposes, and EXECUTE is held by
--      PUBLIC, anon and authenticated on both databases (has_function_privilege,
--      2026-09-07). So it is `POST /rest/v1/rpc/shares_trip_with {"other":
--      "<uuid>"}` with any user JWT: "do I share a trip with X" for any X.
--   2. It gates on NOTHING but the existence of two trip_members rows -- no
--      role, no status. It answers "yes" for a pending invitee (role='member',
--      status='invited'), a removed member (status='removed') and the legacy
--      pending encoding (role='invited'). Same defect as the highlights
--      trip_only branch 2530 replaces; this is that branch's app-era ancestor.
--   3. It takes the OTHER user as a parameter and reads auth.uid() inside. That
--      is the (thing, user) membership-oracle signature 2182 named: the caller
--      can enumerate their relationship to every user id they can guess.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY DROP AND NOT REVOKE
-- ══════════════════════════════════════════════════════════════════════════════
-- Enumerated 2026-09-07 on both databases and in the repository:
--
--   pg_depend            nothing depends on it (no policy, view, function,
--                        trigger, default) -- on either database.
--   pg_policies          no policy expression names it (regex, both databases).
--   pg_proc              no other function's body names it.
--   repository           zero application call sites: no .rpc("shares_trip_with")
--                        anywhere; the only hits are lib/database.types.ts (a
--                        generated type, not a call), the policy-shape guard's
--                        own captured list, and migration prose (0001, 0200,
--                        0201, 2033, 2182, 2530).
--
-- The predicate it approximated exists correctly as authz.shares_accepted_trip
-- (2337): SECURITY DEFINER, in `authz` (not exposed), both sides gated by
-- lib/http.ts requireTripMember's rule, EXECUTE-able by RLS but not addressable
-- as an RPC. Anything that needs the question asks that. A REVOKE would leave a
-- wrong predicate in the catalog for the next reader to reuse; a DROP removes
-- the wrong answer.
--
-- The precondition below re-checks the dependency facts at apply time and
-- refuses if anything has come to depend on it since.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE OWNER MUST ALSO DO (not in SQL)
-- ══════════════════════════════════════════════════════════════════════════════
--   * src/scripts/auditMigrationsVsLive.ts derives "declared functions" from
--     CREATE FUNCTION statements in the corpus and does not understand DROP
--     FUNCTION, so after this is applied it will report function:shares_trip_with
--     as declared-but-missing. Add "function:shares_trip_with" to its ALLOWLIST
--     with a note pointing here, exactly as 4754a9e8 did for is_blocked after
--     2182 relocated it. That file is not lane B5's.
--   * lib/database.types.ts and artifacts/api-server/src/lib/database.types.ts
--     still declare the RPC type. Regenerate them at the next types refresh.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT TOUCH
-- ══════════════════════════════════════════════════════════════════════════════
-- public.can_see_trip(uuid), the other function in the policy-shape guard's
-- captured list, carries a related defect (role gate, no status gate) and is
-- referenced by seventeen live policies. It is repaired by 2534, not here.

BEGIN;

DO $$
DECLARE
  n int;
  who text;
BEGIN
  IF to_regprocedure('public.shares_trip_with(uuid)') IS NULL THEN
    RAISE NOTICE '2533: public.shares_trip_with(uuid) already absent; nothing to do.';
    RETURN;
  END IF;

  -- ── Preconditions: nothing may depend on it ───────────────────────────────
  SELECT count(*), string_agg(pg_describe_object(classid, objid, objsubid), ', ')
    INTO n, who
    FROM pg_depend
   WHERE refobjid = 'public.shares_trip_with(uuid)'::regprocedure
     AND deptype <> 'i';
  IF n <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % object(s) depend on public.shares_trip_with and were not measured: %', n, who;
  END IF;

  SELECT count(*), string_agg(tablename || '.' || policyname, ', ')
    INTO n, who
    FROM pg_policies
   WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '\mshares_trip_with\s*\(';
  IF n <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % policy(ies) name shares_trip_with: %', n, who;
  END IF;

  SELECT count(*), string_agg(ns.nspname || '.' || p.proname, ', ')
    INTO n, who
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.proname <> 'shares_trip_with'
     AND p.prosrc ~ '\mshares_trip_with\s*\(';
  IF n <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % function(s) call shares_trip_with: %', n, who;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_views WHERE definition ~ '\mshares_trip_with\s*\(') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: a view references shares_trip_with.';
  END IF;

  -- The replacement must exist before the wrong answer is removed.
  IF to_regprocedure('authz.shares_accepted_trip(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.shares_accepted_trip(uuid) missing -- apply 2337 first.';
  END IF;

  EXECUTE 'DROP FUNCTION public.shares_trip_with(uuid)';
END $$;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.shares_trip_with(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.shares_trip_with(uuid) still exists.';
  END IF;
  -- No other overload may have survived under the same name in an exposed schema.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE p.proname = 'shares_trip_with' AND ns.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an overload of public.shares_trip_with survives.';
  END IF;
  -- The correct predicate is still there for RLS, and still not for anon as an RPC in public.
  IF NOT has_function_privilege('authenticated', 'authz.shares_accepted_trip(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated lost EXECUTE on authz.shares_accepted_trip; RLS could not evaluate it.';
  END IF;
END $$;

COMMIT;
