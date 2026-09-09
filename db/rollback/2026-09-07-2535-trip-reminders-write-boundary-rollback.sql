-- Rollback for 2535_trip_reminders_write_boundary.sql
--
-- Restores 0079's `trip_reminders_own` and drops the three per-command policies.
--
-- WHAT YOU ARE RESTORING, STATED PLAINLY: `trip_reminders_own` is FOR ALL with
-- no WITH CHECK, so its USING clause becomes the write check, and because
-- PERMISSIVE policies are OR-ed it dominates `trip_reminders_insert` — the
-- `can_see_trip(trip_id)` requirement stops applying to anyone. Running this
-- reopens the write boundary 2535 closed and makes 2534's repair of
-- `trip_reminders_insert` decorative again.
--
-- `trip_reminders_insert` is deliberately not touched here; 2535 did not
-- change it.

BEGIN;

DROP POLICY IF EXISTS "trip_reminders_select" ON public.trip_reminders;
DROP POLICY IF EXISTS "trip_reminders_update" ON public.trip_reminders;
DROP POLICY IF EXISTS "trip_reminders_delete" ON public.trip_reminders;

DROP POLICY IF EXISTS "trip_reminders_own" ON public.trip_reminders;
CREATE POLICY "trip_reminders_own" ON public.trip_reminders
  FOR ALL USING (user_id = auth.uid());

COMMIT;
