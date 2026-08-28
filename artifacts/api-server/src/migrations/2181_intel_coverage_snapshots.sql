-- 2181_intel_coverage_snapshots.sql
-- IG-08 coverage PRODUCER — the derived coverage-gap snapshot table + its flag.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- IG-08's scoring (lib/coverageScore.ts), mission generation (lib/missionGeneration.ts)
-- and service (services/intel/CoverageService.ts) were built, but nothing ASSEMBLED
-- real gap inputs — routes/intelCoverage.ts even documented this: "the demand/claim
-- reader that assembles gap inputs is not wired yet". This adds the derived table the
-- coverage scheduler writes each pass: one row per (zone, claim-family) cell with the
-- assembled inputs and the full score breakdown, so the ops dashboard's GET can read a
-- real ranking instead of a hollow POST.
--
-- DERIVED + TTL'd — recomputable, NOT audit data. Like intel_state_snapshots (2130),
-- each row carries expires_at so a filled/undemanded gap that stops being rewritten
-- ages out of the read instead of lingering as a false open gap; the producer prunes
-- expired rows each pass so the table cannot grow without bound. service_role gets
-- INSERT/SELECT/DELETE (the prune); no client grant, RLS deny-default. SHADOW: the
-- scheduler is gated by intel_coverage, seeded OFF, so this stays empty until enabled.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.intel_coverage_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city                  text NOT NULL DEFAULT '',
  zone_id               text,                         -- '' / null = zoneless cell
  claim_family          text NOT NULL,
  -- assembled inputs (audit trail for the score)
  demand_events         integer NOT NULL DEFAULT 0 CHECK (demand_events >= 0),
  claim_missing         boolean NOT NULL,
  freshest_age_ratio    numeric,                      -- null when claim_missing
  current_confidence    numeric NOT NULL DEFAULT 0,
  required_confidence   numeric,
  top_contributor_share numeric NOT NULL DEFAULT 0,
  -- score + the five normalised factors (each in [0,1])
  score                 numeric NOT NULL,
  demand_weight         numeric NOT NULL,
  freshness_gap         numeric NOT NULL,
  claim_importance      numeric NOT NULL,
  confidence_gap        numeric NOT NULL,
  source_diversity_gap  numeric NOT NULL,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  -- freshness horizon: the read serves only unexpired rows, the producer prunes
  -- past it. A still-real gap is rewritten every pass with a new horizon; a gap
  -- that stops being written simply expires.
  expires_at            timestamptz NOT NULL DEFAULT (now() + interval '1 hour')
);

-- Read path: latest UNEXPIRED snapshot per (zone, claim-family), worst gap first.
CREATE INDEX IF NOT EXISTS intel_coverage_snapshots_cell_recent_idx
  ON public.intel_coverage_snapshots (zone_id, claim_family, computed_at DESC);
CREATE INDEX IF NOT EXISTS intel_coverage_snapshots_live_idx
  ON public.intel_coverage_snapshots (expires_at);

-- ── RLS + grants (deny-default; service_role INSERT/SELECT + DELETE for prune) ──
ALTER TABLE public.intel_coverage_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_coverage_snapshots FROM PUBLIC;
REVOKE ALL ON public.intel_coverage_snapshots FROM anon;
REVOKE ALL ON public.intel_coverage_snapshots FROM authenticated;
REVOKE ALL ON public.intel_coverage_snapshots FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.intel_coverage_snapshots TO service_role;

-- ── Flags ─────────────────────────────────────────────────────────────────────
-- intel_coverage gates the PRODUCER (the scheduler's snapshot write + mission
-- input assembly). Seeded OFF: off ⇒ the scheduler is an inert no-op.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_coverage',
    false,
    'Runs the IG-08 coverage producer (lib/intelCoverageScheduler): assembles (zone, claim-family) gap inputs from intel claims/observations + saved_places demand, writes intel_coverage_snapshots, and (only when intel_missions is also on) generates mission candidates for the worst gaps. Off = the scheduler writes nothing.'
  )
ON CONFLICT (flag) DO NOTHING;
-- intel_missions already seeded (2130/2167); ensure present for the dispatch gate.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('intel_missions', false, 'Gates IG-08 mission generation/dispatch (non-cash). Off = generate/dispatch nothing; accepted commitments are still honored.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_coverage_snapshots') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_coverage_snapshots not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='intel_coverage_snapshots' AND column_name='expires_at') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expires_at column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'intel_coverage') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_coverage flag not seeded';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DELETE FROM public.feature_flags WHERE flag = 'intel_coverage';
--   DROP TABLE IF EXISTS public.intel_coverage_snapshots;
