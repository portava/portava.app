-- Rollback for 3742_profiles_authority_columns_server_only.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3742 DID
-- =============
--   1. REVOKE UPDATE on 19 profiles authority columns from PUBLIC, anon and
--      authenticated: verified, verified_at, trust_score, trust_label,
--      verification_method, featured_count, created_at, account_status, role,
--      is_official and 2163's nine verification columns.
--   2. Installed trg_profiles_authority_privileged /
--      enforce_profile_authority_privileged(), refusing a non-privileged change
--      (or non-default INSERT) to the first seven.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the trigger and its function, and gives anon and authenticated back the
-- column UPDATE the baseline granted on the seven columns 3742's trigger guards.
--
-- ⚠ IT RE-OPENS WHAT 3742 CLOSED: a signed-in user can again set their own
-- verified badge, verified_at, trust score and label, verification method,
-- featured count and account age through PostgREST. Use it only to recover from
-- a writer 3742 broke, and re-apply 3742 once that writer goes through the
-- service client.
--
-- DELIBERATELY NOT RESTORED: the column UPDATE on account_status (3600, PR #592,
-- owns that column and its postcondition pins the grant's absence), role (2078),
-- is_official and 2163's nine. Each of those has its own trigger, so the grant
-- would hand a client nothing but a 42501; there is no pre-3742 state worth
-- returning to for them.
-- SO THIS IS NOT AN EXACT INVERSE of 3742 (verifier G3d F4): it restores the
-- pre-3742 column grants on the SEVEN only; the other eleven (account_status,
-- is_official and 2163's nine; role was already revoked by 2078) stay revoked.
-- Measured on the full-chain replica: pre-3742 vs after this rollback differ by
-- exactly those 22 COLACL UPDATE lines (11 columns x anon, authenticated).
-- On a database without 3600, account_status is then revoked AND unguarded —
-- closed for UPDATE (an INSERT may still carry it until 3600's trigger lands).
--
-- It changes no row except 3742's own schema_migration_ledger row, which it
-- deletes so the runner re-applies 3742 later.

BEGIN;

DROP TRIGGER IF EXISTS trg_profiles_authority_privileged ON public.profiles;
DROP FUNCTION IF EXISTS public.enforce_profile_authority_privileged();

GRANT UPDATE (
  verified, verified_at, trust_score, trust_label, verification_method,
  featured_count, created_at
) ON TABLE public.profiles TO anon, authenticated;

DELETE FROM public.schema_migration_ledger WHERE filename = '3742_profiles_authority_columns_server_only.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass
              AND tgname = 'trg_profiles_authority_privileged') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3742 rollback): trg_profiles_authority_privileged is still installed.';
  END IF;
  IF to_regprocedure('public.enforce_profile_authority_privileged()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3742 rollback): enforce_profile_authority_privileged() still exists.';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'verified_at', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3742 rollback): the pre-3742 column grants on the seven trigger-guarded columns are not back (the other eleven stay revoked by design).';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'account_status', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3742 rollback): account_status was handed back; 3600 owns it.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3742_profiles_authority_columns_server_only.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3742 rollback): the ledger still records 3742 as applied.';
  END IF;
END $post$;
