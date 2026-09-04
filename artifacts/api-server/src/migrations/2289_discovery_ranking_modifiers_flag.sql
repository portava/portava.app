-- 2289_discovery_ranking_modifiers_flag.sql
-- Discovery — ONE capability flag for the ROADMAP step 7/8 modifiers, seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2289.
--
-- Additive + idempotent. Safe to re-run. Seeds exactly one flag with a LIVE
-- reader (check-flag-polarity rule: "a flag arrives with the unit that reads
-- it"). `*_enabled` ⇒ CAPABILITY convention: read fail-closed via isFlagEnabled,
-- so an unreadable flag leaves every modifier OFF, never silently on.
--
-- WHAT THE FLAG GATES — all three, together, or none:
--
--   1. local_momentum       lib/discoveryLocalMomentum.ts — a place-level
--                           48 h-vs-baseline velocity signal, entering
--                           portavaRank as a CAPPED additive feature
--                           (LOCAL_MOMENTUM_MAX_CONTRIBUTION). ROADMAP step 7:
--                           "capped local_momentum as modifiers only".
--   2. exploration governor services/ranking/FeedSlotAllocator.ts
--                           allocateExplorationBudget — a 15-25 % budgeted
--                           allocator with reason codes. ROADMAP step 8. With
--                           the flag OFF the governor still COMPUTES its
--                           allocation and records it in the impression
--                           feature vector (analytics visible either way); it
--                           only REORDERS the served page when ON.
--   3. city-confidence      compass_city_confidence (Phase 15 world model)
--      input                consumed by lib/discoveryModifiers.ts as a bounded
--                           input: it scales momentum in [0.5, 1] and sets the
--                           governor budget in [15, 25] — thin cities explore
--                           more and trust behavioural velocity less.
--
-- WHY ONE FLAG AND WHY OFF: the ranker is on explicit HOLD (docs/discovery/
-- ROADMAP.md, owner ruling 2026-08-15 item 4 — "no optimising ranking
-- machinery over an empty corpus"). These are built so the contracts exist and
-- are tested; enabling them is an owner decision and is NOT made here.
--
-- Reader: lib/discoveryModifiers.ts (DISCOVERY_MODIFIERS_FLAG, literal name).
--
-- RUNTIME EFFECT: NONE. With the flag absent or false, lib/discoveryPde.ts
-- ranks exactly as before this migration: no momentum read, no city-confidence
-- read, portavaRank's own exploration untouched, served order unchanged.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_ranking_modifiers_enabled',
    false,
    'Discovery ROADMAP step 7/8 modifiers, as ONE switch: capped local_momentum (48 h velocity vs the place''s own 30-day baseline, max +0.15 score — never above a taste signal), the exploration GOVERNOR (15-25 % budgeted allocator with reason codes, replacing portavaRank''s fixed every-7th slot on this surface), and the world-model city-confidence input (scales momentum 0.5-1.0, sets the governor budget 15-25 %). OFF (the seed): the ranker runs exactly as before; the governor still records the allocation it WOULD have made in the impression feature vector so analytics are visible either way. Fail-closed (isFlagEnabled). Read by lib/discoveryModifiers.ts. The ranker is on owner HOLD — enabling this is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF) ────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_ranking_modifiers_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected discovery_ranking_modifiers_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_ranking_modifiers_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_ranking_modifiers_enabled seeded ON — the ranker is on hold and this must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'discovery_ranking_modifiers_enabled';
-- The reversal removes a disabled capability flag; no served data changes.
