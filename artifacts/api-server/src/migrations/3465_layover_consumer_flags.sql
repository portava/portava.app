-- 3465_layover_consumer_flags.sql
-- Two Layover capability flags (census-discovery A13 and A14, §81; register
-- D-W10S2-1 and D-W10S2-3), seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery
-- cross-architecture lane W10-S2, 3465-3469). APPLIED TO NO SHARED DATABASE by
-- the lane that wrote it; rehearsed on the local PostgreSQL 16 harness only.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention.
--
-- ── WHAT EACH GATES ─────────────────────────────────────────────────────────
-- `layover_snapshot_consumers_enabled` — services/airport/LayoverSnapshot.ts
--   `consumerLayoverSnapshot`. ON: the dashboard (Trips card, Map envelope),
--   Safe Return (/return-now, /return-deadline, /disruption's current record),
--   the plan and its pins, the buddy gate, the recommendations and the
--   in-layover Compass answer read the ONE certified snapshot instead of
--   certifying inline. Every one of them publishes the same record it did,
--   except the Compass answer, whose usable minutes become the record's
--   envelope figure instead of its own `cutoff − now − buffer` (they differ
--   early in a layover, before the exit delay has elapsed).
--   OFF / absent / unreadable: every consumer takes its legacy arm, byte-identical.
-- `layover_place_dwell_enabled` — services/airport/LayoverPlaceDwell.ts
--   `readCuratedDwell`. ON: Discovery's Layover mode reads a place's curated
--   dwell (`layover_place_dwell`, 3466) for a place the traveller has not
--   planned. A place is still ADMITTED only when its journey is measured too
--   (a routed provider or the traveller's stop). OFF / absent / unreadable:
--   nothing is read and the timing module is byte-identical.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Both FALSE; the postcondition refuses a seed that finds either ON. Turning
-- either ON in production is the owner's decision (APPROVAL REQUIRED in
-- docs/architecture/discovery-decision-register.md, W10-S2).
--
-- Rollback: db/rollback/2026-09-28-3465-layover-consumer-flags-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3465): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_snapshot_consumers_enabled',
    false,
    'Layover consumers read the certified snapshot (census-discovery A13, §81, D-W10S2-1). ON: the dashboard, Safe Return, the plan, the buddy gate, the recommendations and the in-layover Compass answer read certifiedLayoverSnapshot instead of certifying inline; each publishes the same record, and the Compass answer''s usable minutes become the record''s envelope figure. OFF / absent (the seed): every consumer certifies inline exactly as before. Turning it ON in production is an owner decision.'
  ),
  (
    'layover_place_dwell_enabled',
    false,
    'Layover mode reads a place''s curated dwell (census-discovery A14, §81, D-W10S2-3): layover_place_dwell fills the activity term for a place the traveller has not planned; admission still needs a measured journey. OFF / absent (the seed): nothing is read. Turning it ON in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('layover_snapshot_consumers_enabled', 'layover_place_dwell_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3465): expected both flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('layover_snapshot_consumers_enabled', 'layover_place_dwell_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3465): a Layover consumer flag is ON — production activation is an owner decision and these must ship OFF';
  END IF;
END $post$;
