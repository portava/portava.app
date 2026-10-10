-- Rollback for artifacts/api-server/src/migrations/3665_telegraph_forwarding_and_structured_schemas.sql
-- Telegraph §30A.9 forwarding provenance / content capabilities, and the §30A.16 schema flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every author-stated content capability and every provenance row. The derivatives themselves
-- (ordinary rows in public.messages) are NOT deleted — they stay as messages from the person who
-- forwarded them, without the "Forwarded" label, and AN EXPIRES_WITH_SOURCE DERIVATIVE WILL NO
-- LONGER EXPIRE WITH ITS SOURCE once the trigger is gone. Read that twice before running this.
--
-- CHECK BEFORE RUNNING:
--
--     SELECT provenance, capability, (revoked_at IS NULL) AS live, count(*)
--       FROM public.message_forwards GROUP BY 1, 2, 3 ORDER BY 4 DESC;
--
-- If live EXPIRES_WITH_SOURCE rows exist, decide first whether to tombstone those derivatives:
--
--     UPDATE public.messages m SET deleted_at = now(), body = ''
--       FROM public.message_forwards f
--      WHERE f.target_message_id = m.id AND f.capability = 'EXPIRES_WITH_SOURCE'
--        AND f.revoked_at IS NULL AND m.deleted_at IS NULL;
--
-- THE FLAGS ARE ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag IN ('telegraph_forwarding_enabled', 'telegraph_structured_schemas_enabled');
--
-- That stops every new forward and every negotiation while the expiry trigger keeps running.

BEGIN;

DROP TRIGGER IF EXISTS telegraph_forward_expire_on_tombstone ON public.messages;
DROP TRIGGER IF EXISTS telegraph_forward_expire_on_delete ON public.messages;
DROP TRIGGER IF EXISTS telegraph_forward_expire_after_delete ON public.messages;
DROP TRIGGER IF EXISTS telegraph_forward_capability_ratchet ON public.message_content_capabilities;
DROP FUNCTION IF EXISTS public.telegraph_forward_expire_with_source();
DROP FUNCTION IF EXISTS public.telegraph_forward_mark_on_source_delete();
DROP FUNCTION IF EXISTS public.telegraph_forward_expire_pending();
DROP FUNCTION IF EXISTS public.telegraph_forward_ratchet_capability();
DROP FUNCTION IF EXISTS public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text);
DROP TABLE IF EXISTS public.message_forwards;
DROP TABLE IF EXISTS public.message_content_capabilities;

-- The flag rows, only if they still carry this file's own seed descriptions.
DELETE FROM public.feature_flags
 WHERE (flag = 'telegraph_forwarding_enabled'
        AND description LIKE 'CAPABILITY gate for Telegraph §30A.9 forwarding%')
    OR (flag = 'telegraph_structured_schemas_enabled'
        AND description LIKE 'CAPABILITY gate for Telegraph §30A.16 versioned structured-message schemas%');

DO $$
BEGIN
  IF to_regclass('public.message_forwards') IS NOT NULL OR to_regclass('public.message_content_capabilities') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3665): a 3665 table still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass
              AND tgname IN ('telegraph_forward_expire_on_tombstone', 'telegraph_forward_expire_on_delete',
                             'telegraph_forward_expire_after_delete')) THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3665): an expiry trigger still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('telegraph_forward_expire_with_source', 'telegraph_forward_mark_on_source_delete',
                                                     'telegraph_forward_expire_pending', 'telegraph_forward_ratchet_capability',
                                                     'telegraph_record_forward')) THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3665): a 3665 function still exists.';
  END IF;
END $$;

COMMIT;
