-- Rollback for 3655_telegraph_outbox_drain.sql
-- NOT applied to any database at the time of writing.
--
-- WHAT 3655 DID
-- =============
--   * Added telegraph_outbox.locked_until and telegraph_outbox.disposition (+ its CHECK).
--   * Created telegraph_outbox_claim / _ack / _fail (SECURITY INVOKER, service_role only).
--   * Re-asserted REVOKE ALL on telegraph_outbox from PUBLIC/anon/authenticated (3504's state).
--   * Seeded telegraph_outbox_fanout_enabled FALSE.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes the flag FIRST (the application reads it false-on-absent, so the send
-- route goes back to publishing message.created directly and the drainer
-- claims nothing), then drops the three functions and the two columns. Outbox
-- rows themselves are 2810's and are left in place; published_at on rows the
-- drainer consumed stays set. The REVOKE is not undone: 3504 owns that state.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'telegraph_outbox_fanout_enabled';

DROP FUNCTION IF EXISTS public.telegraph_outbox_claim(integer, integer, integer);
DROP FUNCTION IF EXISTS public.telegraph_outbox_ack(uuid[], text);
DROP FUNCTION IF EXISTS public.telegraph_outbox_fail(uuid, text);

ALTER TABLE public.telegraph_outbox DROP CONSTRAINT IF EXISTS telegraph_outbox_disposition_check;
ALTER TABLE public.telegraph_outbox DROP COLUMN IF EXISTS disposition;
ALTER TABLE public.telegraph_outbox DROP COLUMN IF EXISTS locked_until;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_outbox_fanout_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3655): the flag row survived.';
  END IF;
  IF to_regprocedure('public.telegraph_outbox_claim(integer, integer, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3655): telegraph_outbox_claim survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'telegraph_outbox'
                AND column_name IN ('locked_until', 'disposition')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3655): a 3655 column survived.';
  END IF;
END $post$;

COMMIT;
