-- 2272_wall_context_thread_flags.sql
-- Portava Wall — Phase 2 capability flags: Context Threads (§8/§9) and the
-- Rent-a-Buddy context surface (§19).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Wall band 2272.
--
-- Additive + idempotent. Safe to re-run. Seeds exactly the TWO new Wall
-- capability flags whose READERS land in this same wave, per the
-- check-flag-polarity rule "a flag arrives with the unit that reads it" — so the
-- admin surface never shows a switch that gates no code path:
--
--   wall_context_threads_enabled   services/wall/ContextThreadService (the §9
--                                  gate) via WallProjectionService.attachContextThreads,
--                                  called from routes/wall.ts. OFF ⇒ no object
--                                  ever carries a contextThread.
--   wall_rab_integration_enabled   services/wall/ContextThreadService
--                                  readBuddyCandidate (the buddy Context Thread),
--                                  gated through routes/wall.ts. OFF ⇒ no buddy
--                                  Context Thread is ever built.
--
-- BOTH SEEDED OFF. Every reader is fail-closed via isFlagEnabled, so an
-- unreadable flag leaves the feature OFF, never silently on.
--
-- NOT re-seeded here (already seeded by 2270, and read by the diversity /
-- discovery wiring that also landed with its reader): wall_enabled,
-- wall_live_for_you_enabled, wall_discovery_insertions_enabled,
-- wall_input_intelligence_enabled, wall_compass_handoff_enabled. The Feed
-- Diversity Controller (§15) is NOT flag-gated — it is a quality/safety pass
-- applied whenever the Wall is on, so it introduces no flag.
--
-- RUNTIME EFFECT: NONE. The whole Wall is still dark behind wall_enabled = false
-- (2270). Even with wall_enabled pressed, both of these stay OFF until the owner
-- presses them, at which point Context Threads / buddy threads begin to appear
-- only where the §9 gate admits them. No table or grant change here.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed the two Phase-2 Wall flags (CAPABILITY, both OFF) ───────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'wall_context_threads_enabled',
    false,
    'Wall Phase 2 (spec §8/§9). OFF (the seed): no Wall object carries a Context Thread. ON: services/wall/ContextThreadService builds a compact bridge beneath an object ONLY when the §9 eligibility gate admits it (viewer-authorized, confident, fresh, non-sensitive, not a Live-strip duplicate, not overloaded, and useful enough). Read once per request by WallProjectionService.attachContextThreads via routes/wall.ts. Fail-closed (isFlagEnabled).'
  ),
  (
    'wall_rab_integration_enabled',
    false,
    'Wall Phase 2 (spec §19). OFF (the seed): no buddy Context Thread is built. ON: a place-linked object may carry a "Buddy available in this area" Context Thread when a Rent-a-Buddy is available_now in the place city — CITY granularity only, never a precise Buddy coordinate, and paid promotion cannot manufacture it. Read by services/wall/ContextThreadService readBuddyCandidate via routes/wall.ts. Fail-closed (isFlagEnabled).'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (both present, both OFF) ──────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('wall_context_threads_enabled','wall_rab_integration_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 2 Wall Phase-2 flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('wall_context_threads_enabled','wall_rab_integration_enabled')
      AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % Wall Phase-2 flag(s) seeded ON — they must ship OFF', on_count;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags
--     WHERE flag IN ('wall_context_threads_enabled','wall_rab_integration_enabled');
-- The reversal only removes disabled capability flags; no served data changes.
