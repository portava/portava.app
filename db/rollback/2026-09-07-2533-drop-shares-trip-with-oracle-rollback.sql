-- Rollback for 2533_drop_shares_trip_with_oracle.sql
--
-- ⚠ REOPENS A SECURITY HOLE. This recreates public.shares_trip_with(uuid)
-- exactly as it stood on both databases before 2533 (pg_get_functiondef md5
-- 78d48831b681063352f8cb2ce8dd71d6) and restores EXECUTE to anon and
-- authenticated, which makes it a PostgREST RPC again:
-- POST /rest/v1/rpc/shares_trip_with answers "do I share ANY trip, in ANY
-- membership state, with user X" for any X. Run it only to reverse 2533
-- deliberately, never as routine cleanup.

BEGIN;

CREATE OR REPLACE FUNCTION public.shares_trip_with(other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  select exists (
    select 1
    from trip_members me
    join trip_members them on them.trip_id = me.trip_id
    where me.user_id = auth.uid() and them.user_id = other
  );
$function$;

GRANT EXECUTE ON FUNCTION public.shares_trip_with(uuid) TO anon, authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.shares_trip_with(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.shares_trip_with(uuid) not restored.';
  END IF;
END $$;

COMMIT;
