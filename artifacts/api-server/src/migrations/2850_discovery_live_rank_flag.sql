-- 2850_discovery_live_rank_flag.sql
-- Seeds `discovery_live_rank_enabled` FALSE — the capability gate for Sensing
-- §8's live ranking layer over Discovery (engine lib/discoveryLiveRank.ts,
-- gated read lib/discoveryLiveRankRead.ts, consumed by routes/discovery.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2850.
--
-- WHAT THE FLAG GATES. A re-ordering layer over the head window of an ALREADY
-- RANKED Discovery feed. With it on, the head rows that carry a canonical
-- places.id are graded on the live claims the ONE read path (lib/liveClaimRead)
-- already serves every surface — live ExperienceState, forecast, travel time,
-- friction, compatibility, freshness, safety and the composite Opportunity
-- value of §8 — and the order is adjusted by a BOUNDED delta. A Live-qualified
-- `unsafe_density` reading DEMOTES and can never promote (§7/§16: safety
-- outranks opportunity). It reads only baseline tables (feature_flags,
-- intel_state_snapshots, intel_live_promoted_scopes — all present in
-- production) and writes nothing.
--
-- Seeded FALSE. Read fail-closed by lib/discoveryLiveRankRead.liveRankEnabled
-- (via lib/featureFlags.isFlagEnabled): absent, false or unreadable all mean
-- the serve path returns the very array it was handed, same reference, with no
-- claim read and no row moved — the served JSON is byte-identical to today's.
-- Enabling is an owner decision: Discovery is a live user-facing surface and
-- this flag changes the ORDER a real user is served. The postcondition below
-- refuses to commit this file if the row reads TRUE.
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
  ('discovery_live_rank_enabled', false,
   'Sensing §8: GET /discovery re-ranks its head window on live ExperienceState, forecast, travel time, friction, compatibility, freshness, safety and Opportunity value, through lib/liveClaimRead. Bounded delta over the existing personal ranker; a Live-qualified unsafe_density demotes and never promotes; no live evidence moves nothing (no coverage is not quiet). Read-only; baseline tables only. FALSE / absent / unreadable (the seed): the serve path returns the same array reference and reads no claim. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'discovery_live_rank_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_live_rank_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_live_rank_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
