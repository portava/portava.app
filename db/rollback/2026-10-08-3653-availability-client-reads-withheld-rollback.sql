-- Rollback for 3653_availability_client_reads_withheld.sql (lane T, lead ruling P-T1).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3653 DID: REVOKE ALL on public.user_availability and
-- public.quick_availability_status from PUBLIC, anon and authenticated. No
-- policy, row, RLS setting or service_role privilege was touched.
--
-- WHAT THIS DOES: re-grants SELECT, INSERT, UPDATE and DELETE on both tables to
-- anon and authenticated — the state production held after 2490 (the baseline's
-- GRANT ALL minus the four privileges RLS cannot police) — and deletes 3653's
-- ledger row so the runner re-applies it later.
--
-- ⚠ IT RE-OPENS THE DOOR 3653 CLOSED. With SELECT back, the six friend / circle /
-- trip SELECT policies again let a crew-mate read an invisible person's weekly
-- grid, "open to meet" and live "free now" status straight from PostgREST (lead
-- ruling P-T1). Use it only to recover from a client reader 3653 broke.

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_availability', 'quick_availability_status'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3653 rollback): public.% does not exist.', t;
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_availability TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_availability TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quick_availability_status TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quick_availability_status TO authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3653_availability_client_reads_withheld.sql';

COMMIT;
