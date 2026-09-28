-- 3485_discovery_trail_exploration_flags.sql
-- Trails ranking machinery (census-discovery §86, lane W10-T): TWO capability
-- flags, both seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-T owns
-- 3485-3494). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed through lib/featureFlags.isFlagEnabled (absent, FALSE and
-- unreadable all read OFF).
--
-- ── WHAT THEY GATE ──────────────────────────────────────────────────────────
-- The owner lifted the 2026-08-15 ranker hold on 2026-09-28 for designs built
-- behind NEW flags seeded FALSE. Both of these reorder or re-select what a
-- Trail page serves, so both ship OFF and turning either on in production is
-- the owner's (docs/architecture/discovery-decision-register.md, W10-T).
--
--   discovery_trail_exploration_enabled  (DV-22, DV-21, DC-04 — `02` §7, §8, §9)
--     ON:  a Trail's modules are served from §7 content states decided at read
--          time from §9's steps 3-5 (services/trails/trailExploration.ts):
--          just_arrived keeps its 7-day horizon, a member past it or with an
--          expand verdict graduates, a taper verdict leaves active rotation,
--          a cooled member is periodically retested; the reserved exploration
--          slots rotate through the backlog least-exposed first; the Trail's
--          own module serves are counted (3487, no viewer id) so its grant
--          moves its own denominator; the decided states are persisted by a
--          compare-and-set under 3381's transition trigger.
--     OFF / absent / unreadable (the seed): none of the above runs; absent and
--          FALSE serve the same bytes (the unflagged §10 rules still apply), nothing is counted, nothing is
--          written (pinned by discoveryTrailExploration.test.ts G0).
--
--   discovery_trail_health_order_enabled  (DC-05 — `02` §11)
--     ON:  inside every module, the members §11's own predicates count against
--          the Trail (a stale object; the dominant contributor's items while
--          contributor_concentration exceeds one third) are served after the
--          others, in the module's own order. Nothing is removed (§11: "not
--          silently erase").
--     OFF / absent / unreadable (the seed): no reorder (pinned, G0).
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds either ON.
--
-- Rollback: db/rollback/2026-09-28-3485-discovery-trail-exploration-flags-rollback.sql
-- (deletes both rows while they are still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3485): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trail_exploration_enabled',
    false,
    'Trails exploration and content lifecycle (census-discovery DV-22, DV-21, DC-04; 02 §7-§9). ON: Trail modules are served from content states decided from §9 steps 3-5 (just_arrived keeps its 7-day horizon, expand graduates, taper leaves rotation, a cooled member is retested), exploration slots rotate least-exposed first, and the Trail''s own module serves are counted per member per day with no viewer id. OFF / absent / unreadable (the seed): none of this runs, absent and FALSE serve the same bytes, and nothing is counted or written. Ranking machinery: turning it on in production is an owner decision.'
  ),
  (
    'discovery_trail_health_order_enabled',
    false,
    'Trails health ordering (census-discovery DC-05; 02 §11). ON: inside each module, members §11''s own predicates count against the Trail (stale objects; the dominant contributor while contributor_concentration exceeds one third) are served after the others, in the module''s own order; nothing is removed. OFF / absent / unreadable (the seed): no reorder. Ranking machinery: turning it on in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('discovery_trail_exploration_enabled', 'discovery_trail_health_order_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3485): expected both Trail ranking flags present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_trail_exploration_enabled', 'discovery_trail_health_order_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3485): a Trail ranking flag is ON — both reorder what a Trail serves, enabling either is an owner decision, and they must ship OFF';
  END IF;
END $post$;
