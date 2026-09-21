-- 2840_opportunity_engine_flag.sql
-- Seeds `opportunity_engine_enabled` FALSE — the capability gate for Sensing
-- §6's pipeline stage, GET /api/intel/opportunities (routes/opportunities.ts;
-- kernel lib/contextKernel + lib/contextKernelRead, engine
-- lib/opportunityEngine over lib/crowdState and lib/forecastState).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2840.
--
-- WHAT THE FLAG GATES. A read-only route that assembles §18.1's nine contexts
-- for one request, runs the Opportunity stage over them (which calls the §10
-- decision engine rather than restating it), and answers the subset of fields
-- the requested surface receives. It writes nothing and reads only baseline
-- tables (feature_flags, places, intel_state_snapshots,
-- intel_live_promoted_scopes, notification_preferences, notifications — all
-- present in production). Behind this flag the Live gates still decide whether
-- any claim is served; with them closed every subject is refused
-- `live_intelligence_unavailable` and no opportunity is invented to fill the
-- page.
--
-- NOT A SECOND CANDIDATE BUILDER. Every existing surface keeps its own
-- candidate path exactly as it is (Sensing §1: existing surfaces keep
-- functioning while new projections are partial or gated). This file adds a
-- stage beside them; it retires nothing.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean the route answers feature_disabled. Enabling is
-- an owner decision — it opens a new user-facing surface — and the
-- postcondition below refuses to commit this file if the row reads TRUE.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. No DDL, no other row. It
-- does NOT self-register in schema_migration_ledger (the apply tooling's job).
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('opportunity_engine_enabled', false,
   'Sensing §6: GET /api/intel/opportunities assembles the §18.1 context kernel (user, temporal, spatial, trip, social, experience, world, safety, attention) and runs the Opportunity stage over it, answering user-specific action relevance per subject with the §5.1 truth of its evidence and the §18.2 window — and no world value of its own. Read-only; baseline tables only. FALSE / absent / unreadable (the seed): the route answers feature_disabled. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'opportunity_engine_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: opportunity_engine_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: opportunity_engine_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
