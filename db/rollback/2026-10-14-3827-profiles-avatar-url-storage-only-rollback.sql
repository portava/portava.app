-- Rollback for 3827_profiles_avatar_url_storage_only.sql (lane PRIV-FIX-3).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3827 DID: REVOKE UPDATE (avatar_url) ON public.profiles FROM PUBLIC, anon, authenticated;
-- created public.enforce_profile_avatar_url_storage_only() and the BEFORE INSERT OR UPDATE trigger
-- trg_profiles_avatar_url_storage_only on public.profiles. No row changed.
--
-- WHAT THIS DOES: drops the trigger and its function, re-grants that one column's UPDATE to anon and
-- authenticated (the baseline's and 3740's column grant) and deletes 3827's ledger row so the
-- runner re-applies it later.
--
-- ⚠ IT RE-OPENS THE DOOR 3827 CLOSED: a signed-in person can point their avatar at any host again,
-- and every viewer's device fetches it. Use it only to recover from a client writer 3827 broke.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827 rollback): public.profiles does not exist.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_profiles_avatar_url_storage_only ON public.profiles;
DROP FUNCTION IF EXISTS public.enforce_profile_avatar_url_storage_only();
GRANT UPDATE (avatar_url) ON TABLE public.profiles TO anon;
GRANT UPDATE (avatar_url) ON TABLE public.profiles TO authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3827_profiles_avatar_url_storage_only.sql';

COMMIT;
