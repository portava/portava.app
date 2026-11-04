-- Rollback for 3985_definer_client_execute_and_search_path_pins.sql (written 2026-11-04 on main 28f6e2555,
-- branch sec/definer-grants).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3985 DID (one transaction, privileges and function settings only):
--   * withdrew EXECUTE from PUBLIC, anon and authenticated on add_owner_as_member(),
--     enforce_is_official_privileged(), enforce_profile_role_privileged(), enforce_trip_max_members(),
--     handle_new_user() and event_is_in_state(uuid, event_state[]);
--   * withdrew EXECUTE from PUBLIC and anon on can_post_to_trip(uuid), user_is_event_participant(uuid) and
--     is_accepted_trip_member(uuid) (authenticated kept it);
--   * kept or granted EXECUTE for service_role on all nine;
--   * pinned search_path = '' on ten functions (canonical_events_append_only, input_normalize_city_key,
--     stories_freeze_deleted_at, trip_presence_freshness, trip_reservation_events_append_only,
--     trip_reservation_events_no_direct_delete, trip_snapshot_fold, trip_snapshot_fold_all,
--     trip_snapshot_replay, trip_snapshot_seed).
--
-- WHAT THIS DOES: grants EXECUTE back to PUBLIC, anon and authenticated on the first six and to PUBLIC
-- and anon on the other three — the baseline's state (the Supabase default grants plus PostgreSQL's
-- default PUBLIC grant) — RESETs search_path on the ten, then deletes 3985's ledger row so the runner
-- re-applies it later. service_role is not touched. No policy, body, row or flag changes. On a database
-- where a role already lacked one of these grants before 3985 (portava-ci's advisor did not list anon on
-- the five trigger functions), this restores the wider replay state, not that narrower one.
--
-- WHAT IT REOPENS (say it before running it): POST /rpc/event_is_in_state answers again, for any event
-- id and to a caller who has not signed in, whether that event exists and is in a named state; anon can
-- call can_post_to_trip, user_is_event_participant and is_accepted_trip_member over PostgREST; the five
-- trigger functions are listed as client-executable again (they still cannot be called); and the ten
-- functions resolve unqualified names through the caller's search_path again. Every advisor finding
-- 3985 closed returns.
--
-- DATA: none is read or written apart from the ledger row. A second run is a no-op apart from the ledger
-- delete. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.add_owner_as_member()', 'public.enforce_is_official_privileged()',
    'public.enforce_profile_role_privileged()', 'public.enforce_trip_max_members()', 'public.handle_new_user()',
    'public.event_is_in_state(uuid, public.event_state[])', 'public.can_post_to_trip(uuid)',
    'public.user_is_event_participant(uuid)', 'public.is_accepted_trip_member(uuid)',
    'public.canonical_events_append_only()', 'public.input_normalize_city_key(text)',
    'public.stories_freeze_deleted_at()', 'public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)',
    'public.trip_reservation_events_append_only()', 'public.trip_reservation_events_no_direct_delete()',
    'public.trip_snapshot_fold(jsonb, jsonb)', 'public.trip_snapshot_fold_all(jsonb, jsonb[])',
    'public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)', 'public.trip_snapshot_seed(uuid)'] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985 rollback): % does not exist.', v_sig;
    END IF;
  END LOOP;
END $pre$;

GRANT EXECUTE ON FUNCTION public.add_owner_as_member() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_is_official_privileged() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_profile_role_privileged() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_trip_max_members() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_is_in_state(uuid, public.event_state[]) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_post_to_trip(uuid) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_is_event_participant(uuid) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_accepted_trip_member(uuid) TO PUBLIC, anon;

ALTER FUNCTION public.canonical_events_append_only() RESET search_path;
ALTER FUNCTION public.input_normalize_city_key(text) RESET search_path;
ALTER FUNCTION public.stories_freeze_deleted_at() RESET search_path;
ALTER FUNCTION public.trip_presence_freshness(timestamptz, timestamptz, timestamptz) RESET search_path;
ALTER FUNCTION public.trip_reservation_events_append_only() RESET search_path;
ALTER FUNCTION public.trip_reservation_events_no_direct_delete() RESET search_path;
ALTER FUNCTION public.trip_snapshot_fold(jsonb, jsonb) RESET search_path;
ALTER FUNCTION public.trip_snapshot_fold_all(jsonb, jsonb[]) RESET search_path;
ALTER FUNCTION public.trip_snapshot_replay(uuid, jsonb, bigint, bigint) RESET search_path;
ALTER FUNCTION public.trip_snapshot_seed(uuid) RESET search_path;

DO $post$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.add_owner_as_member()', 'public.enforce_is_official_privileged()',
    'public.enforce_profile_role_privileged()', 'public.enforce_trip_max_members()', 'public.handle_new_user()',
    'public.event_is_in_state(uuid, public.event_state[])', 'public.can_post_to_trip(uuid)',
    'public.user_is_event_participant(uuid)', 'public.is_accepted_trip_member(uuid)'] LOOP
    IF NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985 rollback): a client role or service_role cannot execute %.', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'public.canonical_events_append_only()', 'public.input_normalize_city_key(text)',
    'public.stories_freeze_deleted_at()', 'public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)',
    'public.trip_reservation_events_append_only()', 'public.trip_reservation_events_no_direct_delete()',
    'public.trip_snapshot_fold(jsonb, jsonb)', 'public.trip_snapshot_fold_all(jsonb, jsonb[])',
    'public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)', 'public.trip_snapshot_seed(uuid)'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985 rollback): % still carries a search_path setting.', v_sig;
    END IF;
  END LOOP;
END $post$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3985_definer_client_execute_and_search_path_pins.sql';

NOTIFY pgrst, 'reload schema';

COMMIT;
