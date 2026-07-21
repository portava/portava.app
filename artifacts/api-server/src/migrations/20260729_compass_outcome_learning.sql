-- Migration 20260729: Phase 14 — Outcome Learning
--
-- compass_outcome_events records the full recommendation outcome chain
-- (viewed → saved → went → stayed → liked → invited → made_memory → returned),
-- each row tied back to the originating recommendation in
-- compass_served_recommendations via recommendation_id.
--
-- predicted_match snapshots the Compass Match (0–100) that was persisted in
-- compass_served_recommendations.ranking_factors at delivery time, so
-- predicted-vs-actual fit is measurable per recommendation.
--
-- stage_value carries the value-delivered points for the stage (fixed at
-- record time so historical aggregates are stable if weights evolve).

CREATE TABLE IF NOT EXISTS public.compass_outcome_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recommendation_id text        NOT NULL,
  item_id           text        NOT NULL,
  item_type         text        NOT NULL,
  stage             text        NOT NULL CHECK (stage IN
                      ('viewed','saved','went','stayed','liked','invited','made_memory','returned')),
  stage_value       numeric     NOT NULL DEFAULT 0,
  predicted_match   numeric,
  source            text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, recommendation_id, stage)
);

CREATE INDEX IF NOT EXISTS compass_outcome_events_user_time_idx
  ON public.compass_outcome_events (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS compass_outcome_events_rec_idx
  ON public.compass_outcome_events (recommendation_id);

CREATE INDEX IF NOT EXISTS compass_outcome_events_time_idx
  ON public.compass_outcome_events (occurred_at DESC);

ALTER TABLE public.compass_outcome_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own compass outcomes" ON public.compass_outcome_events;
CREATE POLICY "users read own compass outcomes"
  ON public.compass_outcome_events FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "service role writes compass outcomes" ON public.compass_outcome_events;
CREATE POLICY "service role writes compass outcomes"
  ON public.compass_outcome_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
