-- Rollback for 3720_trip_plan_privacy_scope_rls.sql
-- NOT applied to portava-ci at the time of writing.
-- NOT applied to production.
--
-- WHAT 3720 DID: added the RESTRICTIVE SELECT policy plan_items_privacy_scope_select
-- on public.trip_plan_items (census-trips §90, TR116).
--
-- WHAT THIS DOES: drops that policy.
--
-- ⚠ IT RE-OPENS THE DOOR 3720 CLOSED: every accepted crew member again reads,
-- through PostgREST and Realtime, the plans another member scoped `private`.
-- The API rule (privateAnchorAccess.ts) is unaffected. Use it only to recover
-- from a client read 3720 broke, and re-apply 3720 as soon as that is fixed.
--
-- It changes no row except 3720's own schema_migration_ledger row, which it
-- deletes so the runner re-applies 3720 later.

BEGIN;

DROP POLICY IF EXISTS "plan_items_privacy_scope_select" ON public.trip_plan_items;
DELETE FROM public.schema_migration_ledger WHERE filename = '3720_trip_plan_privacy_scope_rls.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.trip_plan_items'::regclass AND polname = 'plan_items_privacy_scope_select') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3720 rollback): plan_items_privacy_scope_select is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3720_trip_plan_privacy_scope_rls.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3720 rollback): the ledger still records 3720 as applied.';
  END IF;
END $post$;
