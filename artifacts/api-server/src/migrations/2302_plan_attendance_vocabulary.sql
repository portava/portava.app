-- 2302_plan_attendance_vocabulary.sql
-- Admit the attendance vocabulary the application actually writes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2302.
--
-- Additive + idempotent. Safe to re-run. Widens TWO CHECK constraints and
-- touches nothing else: no new table, no column, no grant, no RLS change, no
-- data change, no flag. No existing row can violate the widened set, because
-- the widened set is a strict superset of the current one.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
--
-- `plan_attendance_events` and `plan_checkins` were created by
-- 0039_plan_geofence_full.sql with NO CHECK constraint on `event_type` /
-- `status`. The constraints below were added OUT OF BAND, directly on the live
-- database (they appear in baseline/20260819_baseline_structure.sql lines 8153
-- and 8169 but in no migration in this repository), using a SHORTER vocabulary
-- than the code has ever emitted:
--
--   plan_attendance_events_event_type_check : suspicious | late | override | excused
--   plan_checkins_status_check              : pending | arrived | no_show | excused
--
-- The application writes different strings, and always has:
--
--   routes/geofence.ts:561  event_type 'suspicious_check_in'
--   routes/geofence.ts:610  event_type 'checked_in_successfully' | 'late_check_in'
--   routes/geofence.ts:852  event_type 'host_manual_override'
--   routes/geofence.ts:32   status     ATTENDANCE_STATUSES — not_checked_in,
--                                      on_the_way, nearby, arrived, late,
--                                      no_show, left
--
-- Every one of those INSERTs is rejected with 23514. supabase-js RESOLVES
-- rather than throws, and `writeAttendanceEvent` swallows the tuple, so nothing
-- surfaced. `plan_attendance_events` holds 0 rows in production and always has.
--
-- Two live consequences fall out of that:
--
--   1. A LATE CHECK-IN CANNOT BE SAVED. geofence.ts sets plan_checkins.status
--      to 'late', the constraint rejects it, `upsertCheckin` returns false, and
--      the route answers "Check-in could not be saved. Please try again." — for
--      a check-in that was otherwise valid. The `plan_attended` trust event is
--      gated on that same boolean, so the Trust engine never sees a late
--      arrival either. Host manual overrides to on_the_way / nearby / left /
--      not_checked_in fail the same way, silently.
--
--   2. TWO READERS ARE PERMANENTLY EMPTY.
--      TrustGamingDetectionService's check-in-cluster scan and
--      routes/admin.ts:519's suspicious-check-in dashboard both read a table
--      nothing can write to. The gaming detector has never flagged anyone and
--      could not have.
--
-- ── WHY WIDEN THE CONSTRAINT RATHER THAN NARROW THE CODE ─────────────────────
--
-- The repository's own migration created these tables unconstrained; the short
-- vocabulary exists only as live drift and has no source in the repo. The code
-- vocabulary is the intended one — it is declared in one place
-- (ATTENDANCE_STATUSES), validated by a zod enum on the override route, and
-- both the writer and the admin reader of 'suspicious_check_in' already agree
-- with each other. Renaming the code to the drifted set would change a public
-- API contract to match an undocumented DDL edit.
--
-- The four legacy labels are RETAINED, not replaced: they are cheap to keep,
-- and dropping a label a live row might hold is the one change here that could
-- fail.
--
-- RUNTIME EFFECT: check-ins that previously failed now persist. No existing
-- behaviour changes for rows that already validated.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.plan_attendance_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_attendance_events does not exist (0039_plan_geofence_full.sql).';
  END IF;
  IF to_regclass('public.plan_checkins') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_checkins does not exist (0039_plan_geofence_full.sql).';
  END IF;
END $$;

-- ── plan_attendance_events.event_type ────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE public.plan_attendance_events
    DROP CONSTRAINT IF EXISTS plan_attendance_events_event_type_check;
  ALTER TABLE public.plan_attendance_events
    ADD CONSTRAINT plan_attendance_events_event_type_check CHECK (event_type IN (
      -- legacy labels retained
      'suspicious','late','override','excused',
      -- what routes/geofence.ts has always written
      'checked_in_successfully','late_check_in','suspicious_check_in','host_manual_override'
    ));
END $$;

-- ── plan_checkins.status ─────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE public.plan_checkins
    DROP CONSTRAINT IF EXISTS plan_checkins_status_check;
  ALTER TABLE public.plan_checkins
    ADD CONSTRAINT plan_checkins_status_check CHECK (status IN (
      -- legacy labels retained
      'pending','arrived','no_show','excused',
      -- routes/geofence.ts ATTENDANCE_STATUSES
      'not_checked_in','on_the_way','nearby','late','left'
    ));
END $$;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE def text; k text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'plan_attendance_events'
     AND c.conname = 'plan_attendance_events_event_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plan_attendance_events_event_type_check is missing';
  END IF;
  FOREACH k IN ARRAY ARRAY[
    'suspicious','late','override','excused',
    'checked_in_successfully','late_check_in','suspicious_check_in','host_manual_override'
  ] LOOP
    IF def NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: event_type % is not admitted (%)', k, def;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'plan_checkins'
     AND c.conname = 'plan_checkins_status_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plan_checkins_status_check is missing';
  END IF;
  FOREACH k IN ARRAY ARRAY[
    'pending','arrived','no_show','excused',
    'not_checked_in','on_the_way','nearby','late','left'
  ] LOOP
    IF def NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: status % is not admitted (%)', k, def;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- REVERSAL (manual — only safe while no row holds a newly-admitted label):
--   ALTER TABLE public.plan_attendance_events DROP CONSTRAINT plan_attendance_events_event_type_check;
--   ALTER TABLE public.plan_attendance_events ADD CONSTRAINT plan_attendance_events_event_type_check
--     CHECK (event_type IN ('suspicious','late','override','excused'));
--   ALTER TABLE public.plan_checkins DROP CONSTRAINT plan_checkins_status_check;
--   ALTER TABLE public.plan_checkins ADD CONSTRAINT plan_checkins_status_check
--     CHECK (status IN ('pending','arrived','no_show','excused'));
