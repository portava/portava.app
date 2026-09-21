-- 2851_layover_live_intersection_flag.sql
-- Seeds `layover_live_intersection_enabled` FALSE — the capability gate for
-- Sensing §11's intersection of layover feasibility with live intelligence
-- (engine lib/layoverLiveIntersection.ts, consumed by
-- services/airport/LayoverRecommendationService.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2851.
--
-- WHAT THE FLAG GATES. A pass over the layover recommendation candidates that
-- reads, through the ONE live read path (lib/liveClaimRead), the live claims
-- for the canonical place each landside card is bridged to, and then:
--   • adds a Live-qualified queue wait to the card's ACTIVITY TIME, so the
--     EXISTING safe-return engine (LayoverSafetyEngine.assess) rates the card
--     against the certified deadline with the minutes a traveller would really
--     spend standing still — this pass decides no feasibility of its own;
--   • drops a card whose place carries a Live-qualified `unsafe_density`
--     (§16: safety outranks opportunity) or a refused walk-in;
--   • orders the survivors by intent-relative experience value, demoting one
--     whose evidence window will have decayed before arrival.
-- A card with NO live reading is untouched in every respect. It reads only
-- baseline tables (feature_flags, discovery_places, intel_state_snapshots,
-- intel_live_promoted_scopes) and writes nothing of its own.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean the pass does not run and no claim is read.
-- Enabling is an owner decision: it can REMOVE a card a traveller would
-- otherwise have been offered, and it changes a safety rating. The
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
  ('layover_live_intersection_enabled', false,
   'Sensing §11: layover recommendations intersect feasibility with live Experience value, forecast, friction and safe-return. A Live queue wait is added to the card''s activity time before LayoverSafetyEngine rates it; a Live unsafe_density or refused walk-in drops the card; survivors order by intent-relative value with a decaying window demoted. No live reading leaves a card untouched. Read-only; baseline tables only. FALSE / absent / unreadable (the seed): the pass does not run. Enabling is an owner decision — it can remove a card and change a safety rating.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'layover_live_intersection_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_live_intersection_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_live_intersection_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
