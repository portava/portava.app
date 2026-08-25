-- 2167_intel_mission_candidates.sql
-- IG-08 Coverage — the mission CANDIDATE store (non-cash) + the intel_missions flag.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Spec §16 (mission generation) + §23 (monetization coupling, "Shadow: pay no
-- platform-funded cash"). A mission here is a structured coverage task with a
-- NON-CASH budget (committed units, never money). The internal dashboard
-- (services/intel/CoverageService.ts via routes/intelCoverage.ts, requireAdmin)
-- generates, dispatches and accepts candidates; ordinary clients never touch it.
--
-- FINANCIAL-CONTROL BOUNDARY (retained regardless of enablement): the CHECK
-- cash_amount = 0 makes it impossible to attach platform-funded cash to a mission
-- through this table. Money transfer is a separate switch behind funding/KYC/tax/
-- fraud infrastructure that does not exist yet.
--
-- The flag intel_missions is seeded OFF; its reader (CoverageService dispatch)
-- ships in the same change. Off means "stop dispatch; honor accepted
-- commitments" (spec §26): generation/dispatch is a no-op, but an already
-- accepted mission stays accepted. NO append-only trigger here — a mission has a
-- lifecycle (candidate → dispatched → accepted), so service_role UPDATE is
-- granted; clients get nothing.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.intel_mission_candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city             text NOT NULL,
  zone_id          text,
  subject_id       uuid REFERENCES public.places(id) ON DELETE SET NULL,
  claim_family     text NOT NULL,
  trigger          text NOT NULL,
  coverage_score   numeric NOT NULL DEFAULT 0 CHECK (coverage_score >= 0 AND coverage_score <= 1),
  question         text NOT NULL,
  evidence_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_units     integer NOT NULL DEFAULT 0 CHECK (budget_units >= 0),
  budget_committed boolean NOT NULL DEFAULT false,
  cash_amount      numeric NOT NULL DEFAULT 0 CHECK (cash_amount = 0),  -- shadow: never platform-funded cash
  status           text NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','dispatched','accepted','expired','aborted')),
  accepted_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deadline         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intel_mission_candidates_city_status_deadline_idx
  ON public.intel_mission_candidates (city, status, deadline);

-- ── RLS + grants (2130 shape: deny-default, REVOKE ALL then grant service_role) ─
ALTER TABLE public.intel_mission_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_mission_candidates FROM PUBLIC;
REVOKE ALL ON public.intel_mission_candidates FROM anon;
REVOKE ALL ON public.intel_mission_candidates FROM authenticated;
REVOKE ALL ON public.intel_mission_candidates FROM service_role;
-- Internal only: the pipeline writes and reads via the service role; no client
-- grant and no authenticated SELECT policy — missions are not user-facing data.
GRANT INSERT, SELECT, UPDATE ON public.intel_mission_candidates TO service_role;

-- ── Flag ──────────────────────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_missions',
    false,
    'Runs IG-08 coverage-mission generation and dispatch (services/intel/CoverageService.ts). Off = stop dispatch, honor accepted commitments; missions are non-cash (cash_amount = 0 enforced by the table). Coverage read is ungated; dispatch/accept are gated.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE has_table int; has_flag int;
BEGIN
  SELECT count(*) INTO has_table FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'intel_mission_candidates';
  IF has_table <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_mission_candidates not created';
  END IF;
  SELECT count(*) INTO has_flag FROM public.feature_flags WHERE flag = 'intel_missions';
  IF has_flag <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_missions flag not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_missions';
--           (and, only if truly abandoning the unit, DROP TABLE public.intel_mission_candidates.)
