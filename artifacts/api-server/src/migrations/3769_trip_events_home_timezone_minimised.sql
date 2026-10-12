-- 3769_trip_events_home_timezone_minimised.sql
--
-- Owner ruling 2026-10-12 (verbatim): "Keep `home_timezone` private by default.
-- Public schedules may show their destination/event timezone."
-- census-trips §94 (the verifier's N1 on 3768, VERIFY-STG e9c124100).
--
-- APPLIED TO NO DATABASE by the lane that wrote it (wave W, trips-tz-priv). Its
-- application is the owner's, together with 3768.
--
-- WHAT WAS OPEN
-- =============
-- 3768 added trips.home_timezone, the OWNER's home zone (a fact about a person,
-- not about the trip; trips.timezone is the destination's). The Trip Kernel
-- copies the whole trips row into every trip-family event:
-- 2450's UPDATE_TRIP / CANCEL / COMPLETE / ARCHIVE / SET_TRIP_COVER / admin hide
-- and CREATE_TRIP set `v_result := to_jsonb(v_trip)`, and the event's
-- `payload_json.result` is that row minus coordinates and scheduler columns
-- only. After 3768, every one of those events carries `home_timezone`.
-- 2420's `trip_events_crew_select` let every accepted crew member read those
-- events through PostgREST. 3976 withdraws that policy and grant, but 3976 is a
-- separate application decision; where it is not applied, the crew reads the
-- owner's home zone one table over from the API that withholds it.
--
-- WHAT THIS FILE DOES
-- ===================
-- A BEFORE INSERT trigger on trip_events removes `home_timezone` from the
-- event's `result`, `payload` and `payload.patch` (and the top level), for
-- EVERY family. The event keeps the NAME of the changed column (UPDATE_TRIP's
-- payload is `changed: [...]`, a key list), so the ledger still says the home
-- zone changed, without saying to what.
--
-- It is a SEPARATE trigger, not an edit of 3976's trip_event_minimised: on a
-- fresh chain 3976 runs after this file and CREATE OR REPLACEs that function,
-- which would silently drop an edit made here. Two BEFORE INSERT triggers that
-- strip disjoint keys commute, so their firing order does not matter.
--
-- WHAT IT DOES NOT TOUCH
-- ======================
-- * trip_command_receipts.result_json keeps the full row: it has zero client
--   grants and zero policies (2420), and the owner's idempotent replay of an
--   UPDATE_TRIP needs it (routes/trips.ts PATCH answers the owner who sent it).
-- * Rows already written. trip_events is append-only (2420; 3976 admits only
--   its own redaction), and this file does not weaken that. Production has no
--   such rows (3768 is applied nowhere but portava-ci); portava-ci's rows are
--   fixtures. The count is reported by NOTICE in the postconditions.
-- * The trips table's PostgREST door. A table-level SELECT (baseline
--   GRANT ALL ... TO anon, authenticated) cannot be narrowed by a column
--   REVOKE (3520's finding), and a column-grant redesign breaks the mobile
--   client's `supabase.from('trips').select('*')`
--   (travel-buddy-standalone/src/services/trips.ts getTrip), including every
--   installed binary. That redesign is proposed in census-trips §94, not done.
--
-- Rollback: db/rollback/2026-10-12-3769-trip-events-home-timezone-minimised-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_events') IS NULL THEN
    RAISE EXCEPTION '3769: trip_events is required (2420)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_events' AND column_name = 'payload_json') THEN
    RAISE EXCEPTION '3769: trip_events.payload_json is required (2420)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_trip_events_home_timezone_minimise' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '3769: trg_trip_events_home_timezone_minimise already exists';
  END IF;
END
$pre$;

-- ── 1. One event payload without the owner's home zone ─────────────────────
CREATE OR REPLACE FUNCTION public.trip_event_home_timezone_removed(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  r jsonb := p;
BEGIN
  IF r IS NULL OR jsonb_typeof(r) <> 'object' THEN
    RETURN r;
  END IF;
  r := r - 'home_timezone';
  IF jsonb_typeof(r->'result') = 'object' THEN
    r := jsonb_set(r, '{result}', (r->'result') - 'home_timezone');
  END IF;
  IF jsonb_typeof(r->'payload') = 'object' THEN
    r := jsonb_set(r, '{payload}', (r->'payload') - 'home_timezone');
    IF jsonb_typeof(r->'payload'->'patch') = 'object' THEN
      r := jsonb_set(r, '{payload,patch}', (r->'payload'->'patch') - 'home_timezone');
    END IF;
  END IF;
  RETURN r;
END;
$fn$;

-- ── 2. At write ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_events_home_timezone_minimise_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  NEW.payload_json := public.trip_event_home_timezone_removed(NEW.payload_json);
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_trip_events_home_timezone_minimise
  BEFORE INSERT ON public.trip_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_events_home_timezone_minimise_on_insert();

REVOKE ALL ON FUNCTION public.trip_event_home_timezone_removed(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_events_home_timezone_minimise_on_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_event_home_timezone_removed(jsonb) TO service_role;

COMMENT ON FUNCTION public.trip_event_home_timezone_removed(jsonb) IS
  '3769 (owner ruling 2026-10-12, census-trips §94): a trip event loses trips.home_timezone (the owner''s home zone) from result, payload and payload.patch. The kernel copies the whole trips row into trip-family events; the home zone is the owner''s alone.';

COMMIT;

-- ── Postconditions (a separate session under the live applier: everything is
--    recomputed from the catalog; nothing the body left behind is read) ───────
DO $post$
DECLARE
  n int;
  v jsonb;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.trip_events'::regclass AND tgname = 'trg_trip_events_home_timezone_minimise'
     AND NOT tgisinternal AND tgenabled = 'O'
     AND tgfoid = 'public.trip_events_home_timezone_minimise_on_insert()'::regprocedure;
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3769): the BEFORE INSERT trigger is missing or disabled'; END IF;

  IF has_function_privilege('anon', 'public.trip_event_home_timezone_removed(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_event_home_timezone_removed(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3769): a client role can EXECUTE trip_event_home_timezone_removed';
  END IF;

  -- The zone goes from every place the kernel puts a trips row or a patch ...
  v := public.trip_event_home_timezone_removed(
         '{"command_type":"UPDATE_TRIP","family":"trip","home_timezone":"Asia/Tokyo",'
         '"payload":{"changed":["home_timezone","title"],"home_timezone":"Asia/Tokyo","patch":{"home_timezone":"Asia/Tokyo","title":"T"}},'
         '"result":{"id":"x","title":"T","timezone":"Europe/Lisbon","home_timezone":"Asia/Tokyo"}}'::jsonb);
  IF position('Asia/Tokyo' in v::text) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3769): the home zone survived: %', v;
  END IF;
  -- ... and nothing else moves: the destination zone, the title, and the NAME
  -- of the changed column stay.
  IF v->'result'->>'timezone' IS DISTINCT FROM 'Europe/Lisbon' OR v->'result'->>'title' IS DISTINCT FROM 'T'
     OR v->'payload'->'patch'->>'title' IS DISTINCT FROM 'T'
     OR v->'payload'->'changed' IS DISTINCT FROM '["home_timezone","title"]'::jsonb
     OR v->>'command_type' IS DISTINCT FROM 'UPDATE_TRIP' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3769): minimisation removed a key that is not the home zone: %', v;
  END IF;
  -- Non-object payloads pass through.
  IF public.trip_event_home_timezone_removed(NULL) IS NOT NULL
     OR public.trip_event_home_timezone_removed('[1]'::jsonb) IS DISTINCT FROM '[1]'::jsonb THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3769): a non-object payload was changed';
  END IF;

  SELECT count(*) INTO n FROM public.trip_events
   WHERE jsonb_typeof(payload_json->'result'->'home_timezone') = 'string'
      OR jsonb_typeof(payload_json->'payload'->'patch'->'home_timezone') = 'string';
  RAISE NOTICE '3769: % trip_events row(s) written before this file carry a non-null home_timezone (append-only; not rewritten)', n;
END
$post$;
