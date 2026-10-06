-- 3783 — Input Intelligence: downstream task outcomes are AGGREGATED AT INGEST,
-- never stored as a per-event row. Census G370; owner decisions OD-INPUT-1/2.
--
-- WHY (independent verification of lane D, finding 5). The opt-in's disclosure
-- says what is kept is kept for 30 days and that turning the setting off
-- deletes it. The per-user counters (3780) do that. But a consented
-- `downstream_task_completed` §44 event was ALSO stored as an
-- input_assistance_telemetry_events row: tied to a per-app-run session (and, by
-- its shared received_at, to that session's other rows), kept 90 days, and
-- impossible to delete on withdrawal because by design the table holds no
-- account id. OD-INPUT-2's other permitted fate is "irreversibly aggregate", so
-- the event is aggregated the moment it arrives and no per-event row exists.
--
-- input_outcome_task_daily: one row per (UTC day, input context, task, ok) with
-- a count. No user id, no session id, no request id, no field id, no time below
-- a day — nothing that can be joined back to a person or a session. It is the
-- only store the G370 metric (successful downstream tasks over reported ones)
-- reads.
--
-- input_record_task_outcome(text, text, boolean): increments today's cell.
-- service_role only. Takes NO user argument, so it cannot be asked to store
-- one. It re-checks input_outcome_learning_enabled (3780); the ingest has
-- already checked the caller's consent.
--
-- Depends on 3780 (the flag). NOT APPLIED BY ITS AUTHOR. Application follows
-- the repository's reviewed PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3783): public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.input_outcome_task_daily (
  day             date    NOT NULL,
  context         text    NOT NULL,
  task            text    NOT NULL,
  ok              boolean NOT NULL,
  completed_count integer NOT NULL DEFAULT 0,
  CONSTRAINT input_outcome_task_daily_pkey PRIMARY KEY (day, context, task, ok),
  CONSTRAINT input_outcome_task_daily_count_nonnegative CHECK (completed_count >= 0),
  CONSTRAINT input_outcome_task_daily_bounded_text CHECK (
    length(context) BETWEEN 1 AND 64 AND length(task) BETWEEN 1 AND 64
  )
);

COMMENT ON TABLE public.input_outcome_task_daily IS
  'OD-INPUT-2 "irreversibly aggregate": consented downstream-task outcomes counted per (UTC day, input context, task, ok) at ingest. No user, session, request or field id and no sub-day time, so no row can be tied to a person. The only source of the G370 metric. Service_role only.';

ALTER TABLE public.input_outcome_task_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.input_outcome_task_daily FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.input_outcome_task_daily TO service_role;

CREATE OR REPLACE FUNCTION public.input_record_task_outcome(
  p_context text,
  p_task    text,
  p_ok      boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_context IS NULL OR p_task IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION 'input_record_task_outcome: context, task and ok are all required';
  END IF;
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag = 'input_outcome_learning_enabled'), false) THEN
    RETURN false;
  END IF;
  INSERT INTO public.input_outcome_task_daily (day, context, task, ok, completed_count)
  VALUES ((now() AT TIME ZONE 'utc')::date, p_context, p_task, p_ok, 1)
  ON CONFLICT (day, context, task, ok)
  DO UPDATE SET completed_count = public.input_outcome_task_daily.completed_count + 1;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.input_record_task_outcome(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.input_record_task_outcome(text, text, boolean) TO service_role;

COMMENT ON FUNCTION public.input_record_task_outcome(text, text, boolean) IS
  'G370 ingest: increments today''s (context, task, ok) count. Takes no user argument. Returns false and writes nothing while input_outcome_learning_enabled is off. Service_role only.';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_outcome_task_daily') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783): input_outcome_task_daily was not created.';
  END IF;
  IF to_regprocedure('public.input_record_task_outcome(text, text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783): input_record_task_outcome was not created.';
  END IF;
  IF has_function_privilege('anon', 'public.input_record_task_outcome(text, text, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.input_record_task_outcome(text, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783): input_record_task_outcome is executable by anon/authenticated.';
  END IF;
  IF has_table_privilege('anon', 'public.input_outcome_task_daily', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_outcome_task_daily', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783): input_outcome_task_daily is reachable by anon/authenticated.';
  END IF;
  -- The point of the table: nothing that names a person or a session.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'input_outcome_task_daily'
       AND column_name IN ('user_id', 'viewer_id', 'actor_id', 'profile_id', 'author_id', 'account_id', 'session_id', 'request_id', 'field_id')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3783): input_outcome_task_daily carries an identifying column.';
  END IF;
END $post$;
