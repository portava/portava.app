-- Rollback for artifacts/api-server/src/migrations/4091_telegraph_diagnostics_durable_audit.sql
--
-- WHAT THIS DESTROYS: the durable audit rows of Telegraph diagnostics reads, if
-- any were written — a re-added five-value CHECK would refuse them, so they are
-- deleted first. CHECK BEFORE RUNNING:
--
--     SELECT count(*) FROM public.admin_access_log WHERE record_type = 'telegraph_diagnostics';
--
-- Those rows are an audit trail. Export them before running this, or turn the
-- flag off instead, which stops new rows while keeping the trail:
--
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag = 'telegraph_diagnostics_durable_audit_enabled';

BEGIN;

DELETE FROM public.admin_access_log WHERE record_type = 'telegraph_diagnostics';

ALTER TABLE public.admin_access_log
  DROP CONSTRAINT IF EXISTS admin_access_log_record_type_check;
ALTER TABLE public.admin_access_log
  ADD CONSTRAINT admin_access_log_record_type_check
  CHECK (record_type = ANY (ARRAY['profile'::text, 'event'::text, 'trip'::text, 'gps_event'::text, 'check_in'::text]));

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_diagnostics_durable_audit_enabled'
   AND description LIKE 'CAPABILITY gate for the durable audit of GET /api/telegraph/diagnostics%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '4091_telegraph_diagnostics_durable_audit.sql';
  END IF;
END $$;

COMMIT;
