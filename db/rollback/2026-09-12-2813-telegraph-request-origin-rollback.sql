-- Rollback for src/migrations/2813_telegraph_request_origin.sql
-- Telegraph §22 — contextual origin on a message request.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every origin recorded on a message request, and the verification that went
-- with it. That loss is real but bounded: an origin is context attached to a
-- request, not the request itself, and nothing downstream keys off it. No
-- request is deleted and no thread is affected.
--
-- CHECK BEFORE RUNNING:
--
--     SELECT origin_type, origin_verified, count(*)
--       FROM public.message_requests
--      WHERE origin_type IS NOT NULL
--      GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- Rows with origin_verified = true are the ones that cannot be recovered: the
-- verification was performed against membership as it stood at request time,
-- and re-running it later can answer differently because people leave trips.
--
-- THE FLAG IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags
--        SET enabled = false
--      WHERE flag = 'telegraph_request_origin_enabled';
--
-- That stops new origins being recorded or read while keeping what is there.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- The CHECK constraints are dropped first and by name. Dropping the columns
-- would take them anyway, but naming them makes a partial run readable: if this
-- file is interrupted, what has happened is visible in pg_constraint rather than
-- inferred.

BEGIN;

ALTER TABLE public.message_requests
  DROP CONSTRAINT IF EXISTS message_requests_origin_verified_check;
ALTER TABLE public.message_requests
  DROP CONSTRAINT IF EXISTS message_requests_origin_pair_check;
ALTER TABLE public.message_requests
  DROP CONSTRAINT IF EXISTS message_requests_origin_type_check;

ALTER TABLE public.message_requests
  DROP COLUMN IF EXISTS origin_verified,
  DROP COLUMN IF EXISTS origin_id,
  DROP COLUMN IF EXISTS origin_type;

-- Postcondition: the columns are gone and message_requests itself is not.
DO $$
BEGIN
  IF to_regclass('public.message_requests') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.message_requests was removed — this rollback must not touch the table itself.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='message_requests'
       AND column_name IN ('origin_type','origin_id','origin_verified')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: an origin column still exists on message_requests.';
  END IF;
END $$;

COMMIT;
