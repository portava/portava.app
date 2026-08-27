-- 2178_deletion_status_check_converge.sql
-- Converge user_deletion_requests.status CHECK to the full state set.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- CI/prod had DRIFTED on this constraint:
--   CI:   status IN ('pending','cancelled','executed','completed','failed')
--   prod: status IN ('pending','executing','cancelled','executed')
-- AccountDeletionService.markRequestCompleted writes status='completed', which
-- prod's CHECK REJECTS — so on prod a finished deletion could never be marked
-- 'completed', the request was re-selected by the scheduler, and the cascade
-- looked stuck / re-ran. This sets a single superset CHECK covering every status
-- the code and both environments use, on both. The separate "executing requires
-- a lease" CHECK (prod-only) is left untouched — it does not match the set form.

DO $$
DECLARE con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname = 'user_deletion_requests'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status = ANY%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_deletion_requests DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_status_check
  CHECK (status IN ('pending', 'executing', 'cancelled', 'executed', 'completed', 'failed'));

DO $$
BEGIN
  -- The status the service actually writes must now be permitted.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname='public' AND r.relname='user_deletion_requests'
      AND c.conname='user_deletion_requests_status_check'
      AND pg_get_constraintdef(c.oid) ILIKE '%completed%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: status CHECK does not permit ''completed''';
  END IF;
END $$;

-- REVERSAL: restore the environment-specific CHECK you had before (they differed).
