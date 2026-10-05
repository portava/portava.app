-- 4120 — Input Intelligence outcome learning: the opt-in, the per-user outcome
-- counters, and the flag that keeps both dark until the owner turns them on.
-- Census G320/G370 (the outcome event) and G5/G14/G322/G323 (a rank term whose
-- input is an OUTCOME rather than an acceptance).
--
-- ── THE OWNER'S DECISIONS THIS IMPLEMENTS (docs/ops/owner-decisions-20261004.md) ──
-- OD-INPUT-1 "Downstream-outcome telemetry: Explicit opt-in, off by default,
--            purpose-limited, and separated from core assistance."
-- OD-INPUT-2 "Per-user outcome counters: Retain for 30 days, then delete or
--            irreversibly aggregate."
--
-- ── input_outcome_consent ──────────────────────────────────────────────────────
-- One row per user, written ONLY by service_role, the same shape as D4's
-- intel_contribution_consent (2172) and for the same reason: the SERVER stamps
-- the disclosure version and the timestamps, so a client cannot forge a grant.
-- It is a SEPARATE consent, not D4: D4 covers contributing to shared place
-- intelligence; this covers using "a suggestion led to a completed task" to rank
-- the same user's own suggestions. One purpose, one switch (purpose-limited).
-- Absent row = never asked = OFF (off by default).
--
-- ── input_outcome_counters ─────────────────────────────────────────────────────
-- Per user, per input context, per canonical entity, per UTC DAY: how many
-- downstream tasks completed with that entity in that field. DAY buckets rather
-- than one running counter, because a running counter updated yesterday still
-- holds a completion from a year ago and could never honour "retain for 30
-- days". With buckets, each completion is deleted whole once its day is 30 days
-- old (lib/intelRetentionScheduler.ts → runInputOutcomeRetentionSweep), and the
-- reader applies the same window so a late sweep can never make an expired
-- completion count. "Delete", not "aggregate": nothing reads an aggregate.
--
-- ── input_record_outcome ───────────────────────────────────────────────────────
-- Upsert-with-increment, keyed by a caller-supplied user id, so service_role
-- only (2258's lesson). It RE-CHECKS CONSENT ITSELF and records nothing for a
-- user whose consent is absent, disabled or withdrawn: the application checks
-- first, and the database refuses anyway, so a future caller that forgets the
-- check still cannot write an outcome for someone who did not opt in.
--
-- ── input_outcome_learning_enabled ─────────────────────────────────────────────
-- Seeded FALSE. While it is off the consent cannot be granted, no outcome is
-- recorded and none is read; withdrawing is always allowed. Turning it on is the
-- owner's decision, after approving the disclosure text
-- (lib/inputAssistance/outcomeLearning.ts INPUT_OUTCOME_DISCLOSURE_V1).
--
-- Both tables cascade from auth.users, so account deletion erases them.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (4120): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (4120): public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.input_outcome_consent (
  user_id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  consent_version text,
  consented_at    timestamptz,
  withdrawn_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- An enabled row must say WHICH disclosure was agreed to and WHEN.
  CONSTRAINT input_outcome_consent_grant_is_stamped
    CHECK (NOT enabled OR (consent_version IS NOT NULL AND consented_at IS NOT NULL))
);

COMMENT ON TABLE public.input_outcome_consent IS
  'OD-INPUT-1: the explicit, off-by-default, purpose-limited opt-in for Input Intelligence outcome learning (a suggestion led to a completed task). Separate from D4 intel consent. Service_role only; server-stamped version and timestamps. Absent row = off.';

CREATE TABLE IF NOT EXISTS public.input_outcome_counters (
  user_id         uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  context         text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  bucket_day      date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  completed_count integer NOT NULL DEFAULT 1,
  CONSTRAINT input_outcome_counters_pkey
    PRIMARY KEY (user_id, context, entity_type, entity_id, bucket_day),
  CONSTRAINT input_outcome_counters_count_positive CHECK (completed_count >= 1),
  CONSTRAINT input_outcome_counters_bounded_text CHECK (
    length(context) BETWEEN 1 AND 64
    AND length(entity_type) BETWEEN 1 AND 40
    AND length(entity_id) BETWEEN 1 AND 200
  )
);

-- The reader's access path: one user's window in one context.
CREATE INDEX IF NOT EXISTS input_outcome_counters_owner_window_idx
  ON public.input_outcome_counters (user_id, context, bucket_day);
-- The retention sweep's access path: everything older than the window.
CREATE INDEX IF NOT EXISTS input_outcome_counters_day_idx
  ON public.input_outcome_counters (bucket_day);

COMMENT ON TABLE public.input_outcome_counters IS
  'OD-INPUT-2: per-user outcome counters, one row per (user, input context, canonical entity, UTC day). Deleted whole 30 days after their day; the reader applies the same window. Written only for users with a valid input_outcome_consent. Feeds a per-user ranking term in lib/inputAssistance/personalization.ts; changes no canonical data.';

ALTER TABLE public.input_outcome_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.input_outcome_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.input_outcome_consent FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.input_outcome_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.input_outcome_consent TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.input_outcome_counters TO service_role;

CREATE OR REPLACE FUNCTION public.input_record_outcome(
  p_user_id     uuid,
  p_context     text,
  p_entity_type text,
  p_entity_id   text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_context IS NULL OR p_entity_type IS NULL OR p_entity_id IS NULL THEN
    RAISE EXCEPTION 'input_record_outcome: user, context, entity_type and entity_id are all required';
  END IF;
  -- OD-INPUT-1, enforced where the write happens: no valid opt-in, no row.
  IF NOT EXISTS (
    SELECT 1 FROM public.input_outcome_consent c
     WHERE c.user_id = p_user_id
       AND c.enabled
       AND c.withdrawn_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.input_outcome_counters (user_id, context, entity_type, entity_id)
  VALUES (p_user_id, p_context, p_entity_type, p_entity_id)
  ON CONFLICT (user_id, context, entity_type, entity_id, bucket_day)
  DO UPDATE SET completed_count = public.input_outcome_counters.completed_count + 1;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.input_record_outcome(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.input_record_outcome(uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.input_record_outcome(uuid, text, text, text) IS
  'OD-INPUT-1/2 write path: increments today''s outcome bucket for one (user, context, entity). Returns false and writes nothing unless the user holds an enabled, unwithdrawn input_outcome_consent. Service_role only.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'input_outcome_learning_enabled',
    false,
    'Input Intelligence outcome learning (OD-INPUT-1/2, census G320/G370/G5/G14/G322/G323): offers the separate opt-in, records per-user outcome counters (30-day day buckets) for users who opted in, and lets a completed task outweigh a bare acceptance in that user''s ranking. OFF / absent (the seed): the opt-in cannot be granted, nothing is recorded or read, ranking is acceptance-only as before. Turning it ON is an owner decision after approving the disclosure text.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.input_outcome_consent') IS NULL OR to_regclass('public.input_outcome_counters') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): a table was not created.';
  END IF;
  IF to_regprocedure('public.input_record_outcome(uuid, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): input_record_outcome was not created.';
  END IF;
  -- Keyed by a caller-supplied user id: an anon/authenticated grant would let
  -- any caller write another user's outcomes (the 2190/2214 lesson).
  IF has_function_privilege('anon', 'public.input_record_outcome(uuid, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.input_record_outcome(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): input_record_outcome is executable by anon/authenticated.';
  END IF;
  IF has_table_privilege('anon', 'public.input_outcome_consent', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_outcome_consent', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_outcome_consent', 'INSERT')
     OR has_table_privilege('anon', 'public.input_outcome_counters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_outcome_counters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_outcome_counters', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): an outcome table is reachable by anon/authenticated — service_role only.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.input_outcome_consent'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.input_outcome_counters'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): row level security is off on an outcome table.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_outcome_learning_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): input_outcome_learning_enabled absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_outcome_learning_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4120): input_outcome_learning_enabled is ON — it must ship OFF.';
  END IF;
END $post$;
