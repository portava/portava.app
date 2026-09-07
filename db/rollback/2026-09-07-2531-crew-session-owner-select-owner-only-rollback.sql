-- Rollback for 2531_crew_session_owner_select_owner_only.sql
--
-- ⚠ REOPENS A SECURITY HOLE. This restores the 0041 predicate
--   (auth.uid() = user_id) OR (auth.uid() = ANY (allowed_member_ids))
-- on crew_session_owner_select, under which ANYONE listed in a live-share
-- session's allowed_member_ids -- a stranger to the trip, a pending invitee, a
-- removed member -- reads that session, active, stopped or expired, and under
-- which crew_sessions_recipients_read decides nothing. Measured on portava-ci
-- 2026-09-07. Run it only to reverse 2531 deliberately.
--
-- Restores exactly the predicate that was live on BOTH databases before 2531
-- (md5 f1295621ca5d6fe3e504256c9427adfd of qual||'|'||with_check). Touches
-- nothing else on the table.

BEGIN;

DROP POLICY IF EXISTS "crew_session_owner_select" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_session_owner_select" ON public.trip_crew_location_sessions
  FOR SELECT USING (
    auth.uid() = user_id
    OR auth.uid() = ANY(allowed_member_ids)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'trip_crew_location_sessions'
       AND policyname = 'crew_session_owner_select'
       AND qual LIKE '%allowed_member_ids%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 0041 predicate not restored.';
  END IF;
END $$;

COMMIT;
