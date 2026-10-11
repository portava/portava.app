-- Rollback for 3753_location_share_purpose.sql
-- NOT applied anywhere at the time of writing.
--
-- WHAT 3753 DID: added trip_crew_location_sessions.purpose (nullable, CHECK
-- against the lib/locationPurposes.ts ids), and a BEFORE UPDATE trigger that
-- makes it immutable. No row was written.
--
-- WHAT THIS ROLLBACK DOES: drops the trigger, its function, the CHECK and the
-- column, and deletes 3753's ledger row so the applier can re-apply it.
--
-- WHY IT CAN REFUSE. Without the column every row is a legacy row, which the
-- code admits for the crew live share (owner decision LSP-1). A row stamped
-- with ANY OTHER purpose would therefore become visible to crew readers after
-- this rollback — a widening. The application writes only
-- 'live_session_sharing', so this refuses only if something else wrote a
-- different purpose; decide what those rows are before rolling back.
-- The 'live_session_sharing' stamps are lost; those rows become legacy rows,
-- read by exactly the readers that read them before.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'trip_crew_location_sessions' AND column_name = 'purpose'
  ) THEN
    EXECUTE $q$SELECT count(*) FROM public.trip_crew_location_sessions
               WHERE purpose IS NOT NULL AND purpose <> 'live_session_sharing'$q$ INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3753): % share row(s) carry a purpose other than live_session_sharing; dropping the column would make them visible to crew live-share readers.', n;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trip_crew_location_sessions_purpose_immutable ON public.trip_crew_location_sessions;
DROP FUNCTION IF EXISTS public.trip_crew_location_sessions_purpose_immutable();
ALTER TABLE public.trip_crew_location_sessions DROP CONSTRAINT IF EXISTS trip_crew_location_sessions_purpose_check;
ALTER TABLE public.trip_crew_location_sessions DROP COLUMN IF EXISTS purpose;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3753_location_share_purpose.sql';
  END IF;
END $$;

COMMIT;
