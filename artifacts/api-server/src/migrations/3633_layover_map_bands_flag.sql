-- 3633_layover_map_bands_flag.sql
-- One Layover capability flag (census-layover L67), seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane L-LIFE
-- 3632-3639). APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` => CAPABILITY convention.
-- NO SCHEMA OBJECT IS CREATED OR CHANGED.
--
-- `layover_map_bands_enabled` — services/airport/layoverMapBands.ts, spec §13's
--   map bands. ON: every plan stop on GET /airport/sessions/:id/overview (and
--   on the stop routes' responses) carries `mapBand` — SAFE / TIGHT / BLOCKED,
--   computed on the server from the certified usable minutes, the landside
--   gate and the stop's own stated travel and stay minutes — and the map card
--   renders it. A closed gate is BLOCKED; a cautionary gate is never SAFE.
--   OFF / absent / unreadable (the seed): the stops are exactly what they were.
--
-- RUNTIME EFFECT OF SEEDING: NONE. FALSE, and the postcondition refuses a seed
-- that finds it ON.
--
-- Rollback: db/rollback/2026-10-10-3633-layover-map-bands-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3633): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_map_bands_enabled',
    false,
    'Layover map bands (spec 13; census-layover L67). ON: each plan stop carries mapBand SAFE/TIGHT/BLOCKED computed server-side from the certified budget and the landside gate, rendered on the map card. OFF / absent (the seed): stops unchanged.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'layover_map_bands_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3633): expected layover_map_bands_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'layover_map_bands_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3633): layover_map_bands_enabled is ON — it must ship OFF';
  END IF;
END $post$;
