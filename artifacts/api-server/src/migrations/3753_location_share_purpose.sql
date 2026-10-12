-- 3753_location_share_purpose.sql
--
-- Telegraph §12 `location_shares` purpose binding (census-telegraph T149, T214,
-- T215, T356, T420; RECON-W cluster A1). POST-CUTOVER CANONICAL FORWARD
-- MIGRATION (3000-3999 band). Wave W lane tg-locpurpose, band 3753-3757.
--
-- ADDITIVE ONLY: one nullable column, one CHECK, one trigger function, one
-- trigger. No row is written, backfilled, deleted or re-purposed. No policy or
-- table grant changes. Idempotent (IF NOT EXISTS / catalog checks /
-- CREATE OR REPLACE).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- trip_crew_location_sessions is the location-share store: it carries audience
-- (allowed_member_ids), precision (visibility_level) and expiry (expires_at) but
-- NOT purpose. lib/locationPurposes.ts publishes twelve location-processing
-- purposes, and nothing joined a share row to one, so a grant made for one
-- purpose could be read by a surface serving another (T215: a meetup grant
-- reused for Nearby).
--
--   purpose  text NULL, CHECK (purpose IS NULL OR purpose IN <the registry ids>).
--            The list is lib/locationPurposes.ts's ids, verbatim; the test
--            src/test/locationSharePurpose.test.ts parses this file and fails if
--            the two differ, so the registry cannot grow past this CHECK silently.
--            Written by TripCrewLiveShareService.startLiveShare
--            ('live_session_sharing'). Every reader filters on it through
--            lib/locationSharePurpose.admitSharesForPurpose.
--
-- NULL IS DELIBERATE, AND IT IS NOT A DEFAULT. Rows that exist before this file
-- carry no purpose, and stamping them would re-purpose data by inference. The
-- code treats a NULL row as visible ONLY to readers serving the purpose of the
-- one writer that ever created rows here (the crew live share) and refuses it
-- for every other reader — the fail-closed default of OWNER DECISION LSP-1
-- (backfill or not). A DEFAULT would have done the opposite: silently given
-- every future direct insert a purpose its author never chose.
--
-- IMMUTABLE. A share's purpose is what the grant was FOR; changing it later is
-- re-using the grant. Client roles hold UPDATE on this table through the
-- baseline's crew_session_owner_update / crew_loc_sessions_own policies, and a
-- column-level REVOKE cannot narrow a table-level grant, so a BEFORE UPDATE
-- trigger refuses any change to `purpose` (including NULL -> value) for every
-- role. An owner backfill (LSP-1) would be its own migration and would say so.
--
-- Unapplied, the code degrades to today's behaviour without widening anything:
-- the writer writes a legacy (NULL) row and the readers treat every row as
-- legacy — visible to the crew live-share readers only, which are the only
-- readers that exist.
--
-- ROLLBACK: db/rollback/2026-10-11-3753-location-share-purpose-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_crew_location_sessions must exist.';
  END IF;
END $pre$;

ALTER TABLE public.trip_crew_location_sessions
  ADD COLUMN IF NOT EXISTS purpose text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.trip_crew_location_sessions'::regclass
       AND conname = 'trip_crew_location_sessions_purpose_check'
  ) THEN
    ALTER TABLE public.trip_crew_location_sessions
      ADD CONSTRAINT trip_crew_location_sessions_purpose_check CHECK (
        purpose IS NULL OR purpose = ANY (ARRAY[
          'safety_anti_spoof',
          'live_session_sharing',
          'derived_traveler_state',
          'geofence_checkin',
          'presence_in_context',
          'safety_return',
          'content_geotag',
          'stamp_content',
          'route_plan_itinerary',
          'journey_observation',
          'intel_claim',
          'aggregate_live_state'
        ]::text[])
      );
  END IF;
END $$;

COMMENT ON COLUMN public.trip_crew_location_sessions.purpose IS
  'The lib/locationPurposes.ts purpose this share was granted for (census-telegraph T149/T215). Set once on insert by the server (crew live share: live_session_sharing); immutable (trigger). NULL = written before 3753: readers admit it only for the crew live share (owner decision LSP-1, fail-closed default).';

CREATE OR REPLACE FUNCTION public.trip_crew_location_sessions_purpose_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'trip_crew_location_sessions.purpose is immutable (share %): a grant cannot be re-purposed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.trip_crew_location_sessions_purpose_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_crew_location_sessions_purpose_immutable() FROM anon;
REVOKE ALL ON FUNCTION public.trip_crew_location_sessions_purpose_immutable() FROM authenticated;

DROP TRIGGER IF EXISTS trip_crew_location_sessions_purpose_immutable ON public.trip_crew_location_sessions;
CREATE TRIGGER trip_crew_location_sessions_purpose_immutable
  BEFORE UPDATE OF purpose ON public.trip_crew_location_sessions
  FOR EACH ROW EXECUTE FUNCTION public.trip_crew_location_sessions_purpose_immutable();

DO $post$
DECLARE
  v_def text;
  r text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'trip_crew_location_sessions'
       AND column_name = 'purpose' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_crew_location_sessions.purpose must be a nullable text column with no default.';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.trip_crew_location_sessions'::regclass
     AND conname = 'trip_crew_location_sessions_purpose_check' AND contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_crew_location_sessions_purpose_check was not created.';
  END IF;
  FOREACH r IN ARRAY ARRAY['safety_anti_spoof','live_session_sharing','derived_traveler_state','geofence_checkin',
                           'presence_in_context','safety_return','content_geotag','stamp_content',
                           'route_plan_itinerary','journey_observation','intel_claim','aggregate_live_state'] LOOP
    IF position(quote_literal(r) IN v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: the purpose CHECK does not admit %: %', r, v_def;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.trip_crew_location_sessions'::regclass
       AND t.tgname = 'trip_crew_location_sessions_purpose_immutable'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
       AND t.tgfoid = 'public.trip_crew_location_sessions_purpose_immutable()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the purpose-immutability trigger is missing or disabled.';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND has_function_privilege(r, 'public.trip_crew_location_sessions_purpose_immutable()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: client role % can EXECUTE the purpose trigger function.', r;
    END IF;
  END LOOP;
END $post$;

COMMIT;
