-- Rollback for artifacts/api-server/src/migrations/2741_layover_session_returning_status.sql
--
-- ORDER MATTERS. The UPDATE must run BEFORE the constraint is narrowed, or the
-- ADD CONSTRAINT will fail validation against any session already marked
-- 'returning'. Those sessions become 'cancelled', which is the same terminal
-- state DELETE /sessions/:id has always defaulted to — not 'active', because a
-- traveller who pressed RETURN TO AIRPORT is not exploring.
--
-- Measured 2026-09-07 in production `ajrurzioarfkagpuxfnb`: 5 layover sessions
-- ever, 0 active, and the flag that permits the 'returning' write is seeded
-- FALSE, so the UPDATE is expected to affect 0 rows.

BEGIN;

UPDATE public.layover_sessions SET status = 'cancelled', updated_at = NOW()
  WHERE status = 'returning';

ALTER TABLE public.layover_sessions DROP CONSTRAINT IF EXISTS layover_sessions_status_check;

ALTER TABLE public.layover_sessions
  ADD CONSTRAINT layover_sessions_status_check
  CHECK (status IN ('active', 'completed', 'cancelled', 'expired'));

DELETE FROM public.feature_flags WHERE flag = 'layover_safe_return_status_enabled';

COMMIT;
