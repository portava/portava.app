-- Rollback for 3741_trip_presence_current_security_invoker.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3741 DID: ALTER VIEW public.trip_presence_current SET (security_invoker = true).
--
-- WHAT THIS DOES: RESETs the option, so the view again reads trip_presence with
-- its owner's rights.
--
-- ⚠ IT RE-OPENS THE DEFECT 3741 CLOSED: every signed-in user reads every
-- trip_presence row of every trip through the view, past
-- trip_presence_select_crew. Use it only to recover from a reader 3741 broke,
-- and re-apply 3741 as soon as that reader is fixed.
--
-- It changes no row except 3741's own schema_migration_ledger row, which it
-- deletes so the runner re-applies 3741 later.

BEGIN;

ALTER VIEW public.trip_presence_current RESET (security_invoker);
DELETE FROM public.schema_migration_ledger WHERE filename = '3741_trip_presence_current_security_invoker.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL pg_options_to_table(c.reloptions) o
              WHERE c.oid = 'public.trip_presence_current'::regclass AND o.option_name = 'security_invoker') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3741 rollback): security_invoker is still set on public.trip_presence_current.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3741_trip_presence_current_security_invoker.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3741 rollback): the ledger still records 3741 as applied.';
  END IF;
END $post$;
