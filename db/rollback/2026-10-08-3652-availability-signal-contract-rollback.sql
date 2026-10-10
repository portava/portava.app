-- Rollback for 3652_availability_signal_contract.sql (lane T, census-telegraph T22 / T23 / T27).
--
-- Turn availability_signal_contract_enabled OFF first (it is seeded FALSE; nothing reads these
-- objects while it is off). Dropping the three tables and the three availability_windows columns
-- loses only what the flag-gated routes wrote: Nearby opt-ins, audience policies, ETA grants and
-- each window's chosen proximity rung / geography cap. With the flag ON and 3652 rolled back,
-- GET /nearby/reachable answers 503 (the contract's reads fail) — the safe direction.

BEGIN;

ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_audience_policy_owner_fkey;
DROP INDEX IF EXISTS public.availability_windows_audience_policy_idx;
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_proximity_visibility_check,
  DROP CONSTRAINT IF EXISTS availability_windows_geography_scope_check;
ALTER TABLE public.availability_windows
  DROP COLUMN IF EXISTS audience_policy_id,
  DROP COLUMN IF EXISTS proximity_visibility,
  DROP COLUMN IF EXISTS geography_scope;

DROP TABLE IF EXISTS public.eta_coordination_grants;
DROP TABLE IF EXISTS public.nearby_consents;
DROP TABLE IF EXISTS public.availability_audience_policies;

DELETE FROM public.feature_flags WHERE flag = 'availability_signal_contract_enabled';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3652_availability_signal_contract.sql';
  END IF;
END $$;

COMMIT;
