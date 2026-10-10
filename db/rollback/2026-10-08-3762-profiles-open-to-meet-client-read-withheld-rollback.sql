-- Rollback for 3762_profiles_open_to_meet_client_read_withheld.sql (lane T, lead ruling P-T1a).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3762 DID: REVOKE SELECT (open_to_meet) ON public.profiles FROM PUBLIC,
-- anon, authenticated. Nothing else.
--
-- WHAT THIS DOES: re-grants that one column's SELECT to anon and authenticated
-- (the baseline's and 3740's column grant) and deletes 3762's ledger row so the
-- runner re-applies it later.
--
-- ⚠ IT RE-OPENS THE DOOR 3762 CLOSED: the public anon key reads every
-- non-private person's open_to_meet again, an invisible owner's included (lead
-- ruling P-T1a). Use it only to recover from a client reader 3762 broke.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3762 rollback): public.profiles does not exist.';
  END IF;
END $$;

GRANT SELECT (open_to_meet) ON TABLE public.profiles TO anon;
GRANT SELECT (open_to_meet) ON TABLE public.profiles TO authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3762_profiles_open_to_meet_client_read_withheld.sql';

COMMIT;
