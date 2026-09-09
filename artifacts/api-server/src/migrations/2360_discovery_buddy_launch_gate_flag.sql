-- 2360_discovery_buddy_launch_gate_flag.sql
-- Discovery — ONE capability flag for the buddy launch-eligibility gate, seeded OFF.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2360.
--
-- Additive + idempotent. Safe to re-run. Seeds exactly one flag with a LIVE
-- reader (check-flag-polarity rule: "a flag arrives with the unit that reads
-- it"). `*_enabled` ⇒ CAPABILITY convention: read fail-closed via isFlagEnabled,
-- so an unreadable flag leaves the gate OFF, never silently on.
--
-- WHAT THE FLAG GATES
--   routes/discoverySearch.ts searchTravelers(isBuddy): with the gate ON,
--   `type=buddies` (and the `buddies` bucket of type=all, and the
--   input-assistance gateway's `buddy` entity) consults `rent_buddy_enabled`
--   — the Rent-a-Buddy marketplace's master switch — and withholds every buddy
--   result while the marketplace is not launched, or while that flag cannot be
--   read. Global Input Intelligence §29 (census-input-intelligence G71): a Buddy
--   suggestion must pass launch eligibility. Before this gate the only
--   predicate was `buddy_verified_at IS NOT NULL`.
--
-- WHY A FLAG AND WHY OFF: Discovery is a live surface and this repository's
-- rule is that nothing changes what a user sees until someone deliberately
-- flips a flag. Measured 2026-09-07: production holds 0 buddy-verified
-- profiles and `rent_buddy_enabled = false`, so today's served output is
-- byte-identical either way — the gate is about construction, not about a
-- present difference. Enabling it is an owner decision and is NOT made here.
--
-- Reader: routes/discoverySearch.ts (DISCOVERY_BUDDY_LAUNCH_GATE_FLAG, literal).
-- Rollback: db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql
-- RUNTIME EFFECT: NONE. With the flag absent or false, searchTravelers runs
-- exactly as before this migration.

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
    'discovery_buddy_launch_gate_enabled',
    false,
    'Discovery buddy launch-eligibility gate (GII §29 / G71). ON: GET /api/discovery/search?type=buddies, the buddies bucket of type=all, and the input-assistance gateway''s buddy entity consult rent_buddy_enabled and return NO buddies while the Rent-a-Buddy marketplace is not launched or that flag cannot be read. OFF (the seed): legacy behaviour — buddy_verified_at IS NOT NULL is the only predicate. Fail-closed (isFlagEnabled). Read by routes/discoverySearch.ts. Enabling is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF) ────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_buddy_launch_gate_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected discovery_buddy_launch_gate_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_buddy_launch_gate_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_buddy_launch_gate_enabled seeded ON — Discovery is live and this must ship OFF';
  END IF;
END $$;

COMMIT;
