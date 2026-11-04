-- Rollback for 3923_discovery_trail_open_telemetry_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3923 DID: inserted discovery_trail_open_telemetry_enabled, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes it ONLY while it is still FALSE — a TRUE row
-- means the owner approved the collection and turned it on; deleting it would
-- silently stop it. It raises instead. Then it deletes 3923's
-- schema_migration_ledger row so the applier re-applies it. The route reads an
-- absent row as OFF and writes nothing, so nothing breaks. Rows already written
-- are a retention decision (`04` §11) and are deliberately left alone.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trail_open_telemetry_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3923): discovery_trail_open_telemetry_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'discovery_trail_open_telemetry_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3923_discovery_trail_open_telemetry_flag.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trail_open_telemetry_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3923 rollback): the flag is still present.';
  END IF;
END $post$;
