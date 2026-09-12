-- 2801_wall_moments_flag.sql
-- Seeds `wall_moments_enabled` FALSE — the capability gate for Sensing §9's
-- WallMoment projection and §15's Attention Engine routing on it,
-- GET /api/wall/moments (routes/wallMoments.ts; lib/wallMoments.ts,
-- lib/attentionEngine.ts, lib/wallMomentRead.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2801.
--
-- WHAT THE FLAG GATES. A read-only route that, for the places a client names,
-- reads the current claims through lib/liveClaimRead (the one gated path),
-- the previous readings from intel_state_snapshot_versions (2273, privacy-
-- eligible rows only), detects the transitions between them, builds
-- WallMoments (subject, transition, occurred_at, relevance window, reason,
-- truth class, confidence, freshness, coverage, expiry) and routes each one
-- through the Attention Engine for the viewer (NOTIFY / WALL / SILENT /
-- IGNORE, with the factors). It writes nothing and sends nothing. It sits
-- behind the Wall's master `wall_enabled` (2270) as well.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean the route answers feature_disabled. Enabling
-- is an owner decision — it opens a new user-facing surface — and the
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
  -- NOTE, not a failure: the previous-reading read needs 2273. Absent here
  -- means "seed the flag; the route reports versions_unavailable per subject
  -- until 2273 lands" — a refusal, never an empty answer.
  IF to_regclass('public.intel_state_snapshot_versions') IS NULL THEN
    RAISE NOTICE '2801: intel_state_snapshot_versions (2273) is not present on this database; GET /wall/moments will report versions_unavailable per subject here until it is applied.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('wall_moments_enabled', false,
   'Sensing §9 / §15: GET /api/wall/moments serves server-built WallMoments — meaningful state transitions of the places a client names, from lib/liveClaimRead (current) against intel_state_snapshot_versions (previous, privacy-eligible only) — each routed through the Attention Engine (NOTIFY / WALL / SILENT / IGNORE) for the viewer. Read-only; sends nothing. Behind wall_enabled too. FALSE / absent / unreadable (the seed): the route answers feature_disabled. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'wall_moments_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: wall_moments_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: wall_moments_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
