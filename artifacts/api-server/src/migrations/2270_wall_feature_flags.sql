-- 2270_wall_feature_flags.sql
-- Portava Wall — feature-flag gating for the Wall backend core (spec §24-28).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Wall band 2270+.
--
-- Additive + idempotent. Safe to re-run. Seeds the Wall's capability flags, ALL
-- OFF. `wall_enabled` is the master gate. `*_enabled` ⇒ CAPABILITY convention:
-- every reader is fail-closed via isFlagEnabled, so an unreadable flag leaves the
-- feature OFF, never silently on.
--
-- ONLY the flags with a LIVE reader are seeded here, per the check-flag-polarity
-- rule "a flag arrives with the unit that reads it" — seeding a flag nothing
-- reads makes the admin list show a control that gates no code path. The Wall
-- backend core (this wave) reads exactly these five:
--
--   wall_enabled                       routes/wall.ts (every route gate)
--   wall_live_for_you_enabled          routes/wall.ts (Live For You strip §4)
--   wall_discovery_insertions_enabled  routes/wall.ts loadCandidates (§13)
--   wall_input_intelligence_enabled    routes/wall.ts session intent (§17)
--   wall_compass_handoff_enabled       WallProjectionService buildActions (§21)
--
-- The later-phase flags (Context Threads §8/§9, Diversity Controller §15, Shared
-- Moments §12, RAB §19) are DELIBERATELY NOT seeded yet: each will be seeded by
-- the migration that also lands its reader, so the admin surface never shows an
-- inert Wall switch. That is the same discipline 2257 followed.
--
-- RUNTIME EFFECT: NONE. With wall_enabled = false the /wall routes short-circuit
-- to a disabled response before any projection/ranking/live read runs. No table
-- or grant change here (the session-intent store is 2271). Nothing is served to
-- any user until the owner presses wall_enabled.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed Wall flags (all CAPABILITY, all OFF) ────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'wall_enabled',
    false,
    'MASTER gate for the Portava Wall social surface (spec §1-3). OFF (the seed): GET /wall, /wall/live and the intent/impression/action routes short-circuit to a disabled response before any canonical read. ON: the Wall assembles For You / Following feeds from canonical objects through the eligibility/privacy/block gates. Fail-closed (isFlagEnabled) — an unreadable flag leaves the Wall OFF.'
  ),
  (
    'wall_live_for_you_enabled',
    false,
    'Wall Phase 2 (spec TABLE 7 / §4). OFF: GET /wall/live returns an empty strip and the feed carries no live strip. ON: the small bounded (2-4) Live For You strip is assembled from lib/liveClaimRead with strict freshness/privacy. Independent of the underlying intel live-label gates, which still apply. Read by routes/wall.ts.'
  ),
  (
    'wall_discovery_insertions_enabled',
    false,
    'Wall Phase 4 (spec TABLE 7 / §13). OFF: For You stays inside eligible fetched content. ON: explainable discovery objects (followed-by / trip / interest / missed / hidden-gem) may be inserted, always visually identifiable. Read by routes/wall.ts loadCandidates.'
  ),
  (
    'wall_input_intelligence_enabled',
    false,
    'Wall Phase 5 (spec TABLE 7 / §17). OFF: typed session intent is ignored (no For You steering). ON: a typed/voice intent is parsed via the Global Input Intelligence layer into a temporary, session-scoped StructuredIntent that steers For You without changing saved preferences. Read by routes/wall.ts.'
  ),
  (
    'wall_compass_handoff_enabled',
    false,
    'Wall Phase 5 (spec TABLE 7 / §21). OFF: no Ask-Compass action on Wall objects. ON: a place-linked object may expose an Ask Compass handoff. Compass never occupies a permanent panel and never presents inference as verified fact. Read by services/wall/WallProjectionService buildActions.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (all present, all OFF) ────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN (
      'wall_enabled','wall_live_for_you_enabled','wall_discovery_insertions_enabled',
      'wall_input_intelligence_enabled','wall_compass_handoff_enabled'
    );
  IF present <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 5 Wall flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag LIKE 'wall\_%' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % Wall flag(s) seeded ON — the Wall must ship OFF', on_count;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag LIKE 'wall\_%';
-- The reversal only removes disabled capability flags; no served data changes.
