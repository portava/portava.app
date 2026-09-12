-- 2800_compass_decision_flag.sql
-- Seeds `compass_decision_enabled` FALSE — the capability gate for Sensing
-- §10's decision surface, GET /api/compass/decision (routes/compassDecision.ts,
-- engine lib/compassDecision.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2800.
--
-- WHAT THE FLAG GATES. A read-only route that answers one of §10's seven
-- decisions (GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN) for a
-- place, from the live claims the ONE read path (lib/liveClaimRead) already
-- serves every surface, with its §5.1 grounding, the peak interception and
-- the switching-cost report. It writes nothing and reads only baseline tables
-- (places, feature_flags, intel_state_snapshots, intel_live_promoted_scopes —
-- all present in production). Behind this flag the Live gates still decide
-- whether any claim is served; with them closed the route answers WAIT and
-- says why, never GO.
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
  ('compass_decision_enabled', false,
   'Sensing §10: GET /api/compass/decision answers GO NOW / GO SOON / WAIT / STAY / SWITCH / SKIP / RETURN for a place from the live claims lib/liveClaimRead serves, with §5.1 grounding, peak interception (§11) and the switching cost of the current experience (§10). Read-only; baseline tables only. FALSE / absent / unreadable (the seed): the route answers feature_disabled. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'compass_decision_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: compass_decision_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: compass_decision_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
