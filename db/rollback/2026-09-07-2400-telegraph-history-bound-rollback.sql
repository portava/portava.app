-- Rollback for 2400_telegraph_history_bound.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07, with a
-- schema_migration_ledger row (applied_by = 'manual').
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2400 DID
-- =============
--   1. ADD COLUMN public.message_thread_members.visible_from_at timestamptz (nullable, no default).
--   2. CREATE FUNCTION public.telegraph_member_visibility_window() and a BEFORE
--      INSERT OR UPDATE trigger of the same name on message_thread_members.
--   3. INSERT one feature_flags row, FALSE, ON CONFLICT DO NOTHING:
--      telegraph_history_bound_enabled
--   No policy, no grant, no backfill.
--
-- WHAT REMOVING THEM DOES
-- =======================
-- Nothing observable while the flag is FALSE. The routes SELECT visible_from_at
-- only when lib/featureFlags.isFlagEnabled reads TRUE, and a MISSING flag row
-- reads as false (maybeSingle -> data null, error null), so every reader takes
-- the unbounded branch either way. Dropping the column and trigger removes a
-- write that nothing reads.
--
-- ⚠ RUN THIS ONLY IF THE FLAG IS STILL OFF. If someone turned it ON, the routes
-- SELECT a column this file drops, every membership read fails with 42703, and
-- GET /threads/:id/messages returns 403 for everybody — an outage disguised as a
-- cleanup. The guard below refuses in that case.
--
-- ⚠ DROPPING THE COLUMN DISCARDS DATA. Every visible_from_at the trigger has
-- written since 2400 was applied is lost. Re-applying 2400 afterwards does NOT
-- restore them (2400 never backfills): every member is unbounded again until
-- their next (re)join. On CI that is the intended reset; on production it would
-- be a decision.
--
-- Idempotent: re-running after the objects are gone is a no-op.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag = 'telegraph_history_bound_enabled' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: telegraph_history_bound_enabled is ON. The routes select visible_from_at while it is ON; dropping the column would 403 every thread read. Set it FALSE deliberately first, then re-run this rollback.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS telegraph_member_visibility_window ON public.message_thread_members;
DROP FUNCTION IF EXISTS public.telegraph_member_visibility_window();
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS visible_from_at;
DELETE FROM public.feature_flags WHERE flag = 'telegraph_history_bound_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '2400_telegraph_history_bound.sql';

COMMIT;
