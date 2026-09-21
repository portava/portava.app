-- Rollback for 2401_telegraph_messages_rls_latent_disclosure.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07, with a
-- schema_migration_ledger row (applied_by = 'manual').
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2401 DID
-- =============
-- Recreated two SELECT policies on public.messages:
--   msg_select                    correlated on messages.thread_id (was the
--                                 tautology mtm.thread_id = mtm.thread_id on
--                                 production; already correct on CI)
--   messages_hide_blocked_sender  AS RESTRICTIVE, requiring auth.uid() IS NOT
--                                 NULL (was PERMISSIVE, OR-ed, admitting anon)
-- No column, no table, no grant, no flag.
--
-- WHAT THIS RESTORES
-- ==================
-- The CI shapes from before 2401: msg_select correctly correlated (CI never had
-- the tautology, so restoring "before" on CI means restoring the correct
-- predicate — this file does NOT reinstate the production tautology anywhere),
-- and messages_hide_blocked_sender PERMISSIVE. It deliberately does NOT
-- recreate the tautology: a rollback that reintroduces a cross-tenant read is
-- not a rollback.
--
-- ⚠ REFUSES IF 2402 IS APPLIED. Once authz.is_active_thread_member exists and
-- mtm_select no longer recurses, a PERMISSIVE messages_hide_blocked_sender is a
-- LIVE grant of every message to every caller (and to anon). Roll 2402 back
-- first, then this.
--
-- Idempotent.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'authz' AND p.proname = 'is_active_thread_member'
  ) THEN
    RAISE EXCEPTION
      'REFUSING: 2402 (authz.is_active_thread_member) is applied. Restoring a PERMISSIVE messages_hide_blocked_sender while mtm_select no longer recurses opens every message to every caller. Roll back 2402 first.';
  END IF;
END $$;

DROP POLICY IF EXISTS messages_hide_blocked_sender ON public.messages;
CREATE POLICY messages_hide_blocked_sender ON public.messages
  FOR SELECT
  USING (NOT authz.is_blocked(auth.uid(), sender_id));

DROP POLICY IF EXISTS msg_select ON public.messages;
CREATE POLICY msg_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.message_thread_members mtm
       WHERE mtm.thread_id = messages.thread_id
         AND mtm.user_id = auth.uid()
         AND mtm.left_at IS NULL
    )
  );

DELETE FROM public.schema_migration_ledger WHERE filename = '2401_telegraph_messages_rls_latent_disclosure.sql';

COMMIT;
