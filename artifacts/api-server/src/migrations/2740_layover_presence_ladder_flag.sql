-- 2740_layover_presence_ladder_flag.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2740.
-- Idempotent. Creates no table, alters no table, moves no row of user data.
-- Seeds ONE feature flag, FALSE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- Seeds `layover_presence_ladder_enabled` = FALSE. When it is ON,
-- `GET /api/airport/sessions/:id/presence` and the `share` block of
-- `/overview` serve the spec §14 default — an AGGREGATE COUNT and nothing else
-- — instead of the count plus up to six named traveller profiles.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- Spec §14: "Aggregate presence should be the default; identity and precise
-- location are progressively disclosed only with user consent." The visibility
-- ladder is L0 aggregate → L1 opt-in intent → L2 mutual discovery → L3 crew →
-- L4 temporary location.
--
-- Census `docs/architecture/census-layover.md` L127 scores this BUILT-BUT-WRONG
-- and states the divergence exactly: sharing is opt-in, off by default,
-- reciprocal, block-filtered both ways and coordinate-free — but it "is not
-- aggregate-FIRST: the very first response returns up to six named traveller
-- profiles with id, handle, name and avatar. The ladder is skipped, not
-- climbed." L128 adds that the count "always ships alongside the profile list".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A FLAG, AND WHY SEEDED FALSE
-- ══════════════════════════════════════════════════════════════════════════════
-- Withholding the profile list CHANGES WHAT A TRAVELLER SEES. Every change on
-- this surface that does so has shipped behind a flag seeded FALSE (2410,
-- `layover_stable_recommendation_ids_enabled`), and this one is no different:
-- it is a product-shape decision about the ladder's first rung, not a defect
-- repair. Flag OFF reproduces today's response byte-for-byte.
--
-- The DEFECT repair that ships alongside it is deliberately NOT behind this
-- flag: `LayoverPrivacyGuard.evaluateSharingGate` / `publishableUserIds` apply
-- the traveller's OWN stored location settings (`location_preferences.
-- location_mode`, `.sharing_paused`, and per-trip ghost mode), which the
-- presence path ignored entirely — measured 2026-09-08, `isSharingAllowed` had
-- no caller outside `src/test/airport.test.ts`. Applying a stored opt-out is
-- not a product change; it is the same repair #442 made for Pulse and
-- Discovery, and it needs no flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- Production `ajrurzioarfkagpuxfnb`, 2026-09-07, read-only aggregates: 5
-- layover sessions ever, from 2 users, 0 active; 30 `layover_recommendations`;
-- 0 `layover_plan_stops`; 38 `layover_events`. Presence has therefore never
-- returned a non-empty traveller list in production — there has never been a
-- second concurrently-active, opted-in session in one city. Flipping this flag
-- changes nothing that has happened; it changes what happens the first time
-- two travellers do overlap.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   DELETE FROM public.feature_flags WHERE flag = 'layover_presence_ladder_enabled';
-- Nothing else is touched, so that single statement restores the prior state
-- exactly. Rollback file: db/rollback/2026-09-08-2740-layover-presence-ladder-flag.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Independent of 2335 / 2410 / 2510 / 2700 / 2741. Safe to apply at any time;
-- applying it alone changes no behaviour, because the flag is FALSE and
-- `isFlagEnabled` is fail-closed (an absent row already reads FALSE).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2740): public.feature_flags is missing.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_presence_ladder_enabled',
    FALSE,
    'CAPABILITY. Layover §14 presence ladder: serve AGGREGATE-ONLY presence (a count) as the default rung instead of the count plus up to six named traveller profiles. OFF = today''s behaviour, byte-for-byte. Does NOT gate the location-privacy repair (location_mode / sharing_paused / ghost mode), which applies unconditionally. SEEDED FALSE.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE
  present INTEGER;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'layover_presence_ladder_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2740): layover_presence_ladder_enabled flag row missing';
  END IF;
  -- Deliberately NOT asserted: enabled = FALSE. The seed is FALSE; a later
  -- owner flip is an owner decision this migration must survive being re-run over.
END $$;

COMMIT;
