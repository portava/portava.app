-- Rollback for 3996_layover_crew_location_grants.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3996 DID: created public.layover_crew_location_controls and
-- public.layover_crew_location_grants (service-role only), four SECURITY
-- INVOKER trigger functions and their triggers (one on each new table's
-- neighbours: layover_crew_members.left_at, layover_crews.status), added
-- 'crew_location_shared' / 'crew_location_stopped' to the layover_events
-- event_type vocabulary, and seeded `layover_crew_location_enabled` FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is TRUE, and refuses while any
-- layover_events row carries one of the two event types (narrowing the CHECK
-- under them would fail, and deleting audit rows is not a rollback's call);
-- otherwise drops the triggers, functions and tables, narrows the vocabulary
-- back, and deletes the flag row and 3996's schema_migration_ledger row.
-- DATA LOSS, stated: every live crew location share and every precise-sharing
-- control is dropped. Both are short-lived by design (a share lasts at most
-- 4 hours and never past boarding or its crew), so nothing a traveller would
-- keep is lost.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): layover_crew_location_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.layover_events WHERE event_type IN ('crew_location_shared', 'crew_location_stopped')) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): layover_events carries crew_location_* rows; the vocabulary cannot be narrowed under them.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS layover_crew_location_member_left ON public.layover_crew_members;
DROP TRIGGER IF EXISTS layover_crew_location_crew_disbanded ON public.layover_crews;
DROP TABLE IF EXISTS public.layover_crew_location_grants;
DROP TABLE IF EXISTS public.layover_crew_location_controls;
DROP FUNCTION IF EXISTS public.layover_crew_location_grant_guard();
DROP FUNCTION IF EXISTS public.layover_crew_location_precise_off();
DROP FUNCTION IF EXISTS public.layover_crew_location_member_left();
DROP FUNCTION IF EXISTS public.layover_crew_location_crew_disbanded();

DO $vocab$
DECLARE
  conname_found TEXT;
  def TEXT;
  vals TEXT;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO conname_found, def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.layover_events'::regclass AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%event_type%' AND pg_get_constraintdef(c.oid) LIKE '%session_created%'
   LIMIT 1;
  IF conname_found IS NULL OR def NOT LIKE '%crew_location_%' THEN
    RETURN;
  END IF;
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO vals
    FROM (SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] AS v) s
   WHERE v NOT IN ('crew_location_shared', 'crew_location_stopped');
  EXECUTE format('ALTER TABLE public.layover_events DROP CONSTRAINT %I', conname_found);
  EXECUTE format('ALTER TABLE public.layover_events ADD CONSTRAINT layover_events_event_type_check CHECK (event_type IN (%s))', vals);
END
$vocab$;

DELETE FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3996_layover_crew_location_grants.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NOT NULL OR to_regclass('public.layover_crew_location_controls') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): a crew location table still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): layover_crew_location_enabled still present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'layover_crew_location_%' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): a crew location trigger still exists';
  END IF;
END $post$;
