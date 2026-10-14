-- 3826_telegraph_context_kernel_flag.sql
-- Telegraph §30A.19 — the Context Kernel (census-telegraph T439, and the §30A.1
-- "relationship policy is an input to ConversationPolicy" half of T381).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. B58 telegraph+media band 3825-3839.
--
-- No table, no column, no grant. The kernel composes five inputs on read
-- (relationship, time, proximity, intent, shared objects) through resolvers that
-- already exist (server/telegraph/telegraphContextKernel.ts); nothing is stored.
-- This file only seeds the capability flag, FALSE:
--   * GET /api/threads/:threadId/context answers feature_disabled;
--   * the §14.1 capability policy does not consult the kernel's relationship
--     term, so every capability is decided exactly as before.
--
-- ROLLBACK: db/rollback/2026-10-14-3826-telegraph-context-kernel-flag-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_context_kernel_enabled', false,
   'CAPABILITY gate for the Telegraph §30A.19 Context Kernel: GET /api/threads/:id/context composes relationship, time, proximity, intent and shared objects for the calling member, and the §14.1 capability policy takes the kernel''s relationship term as an input (canCall follows the call door''s messaging floor). Nothing is stored. OFF (the seed): the route answers feature_disabled and capabilities are decided exactly as before.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_context_kernel_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_context_kernel_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
